import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createChatPolicy } from "../chat-policy.ts";
import { createHeuristics } from "../heuristics.ts";
import { createHistory, createNotesStore } from "../memory.ts";
import { horizontalDistance, observe, tickSnapshot, withinHome } from "../observe.ts";
import { ABOUT_ME, redact, searchHarness } from "../selfinfo.ts";
import type { Bridge, ChatEvent, ChatMessage, Config, Ctx, HeuristicsHost, Notes, SkillEnv } from "../types.ts";

const config: Config = {
  llm: { baseUrl: "http://localhost/v1", model: "qwen", thinking: "planning" },
  chat: { nicknames: ["SirWaffleshnoz", "waffle"], wholeWords: ["bot", "ai"], minIntervalMs: 5, maxLen: 256, maxLinesPerReply: 2 },
  commands: { allowlist: ["/msg", "/home"] }, protect: { naturalBlocks: ["minecraft:oak_log"], zones: [] }, home: [0, 64, 0], selfGoal: { radius: 256 }, reflex: { eatAtFood: 14 },
  reconnect: { maxPerHour: 3, backoffMs: [30000, 120000, 600000], stopPatterns: ["ban"] }, lease: { ttlMs: 3000, intervalMs: 1000 }, server: { host: "localhost", port: 25570 },
  bridge: { url: "http://localhost:25599", configPath: "unused" }, paths: { heuristicsDir: "unused", notesFile: "unused", transcriptDir: "unused" },
};
const ctx: Ctx = { config: {}, notes: {}, log() {}, now: Date.now };
const emptyHost: HeuristicsHost = { onObservation: () => [], onPlanProposed: call => call, onTick: () => undefined, onChat: () => undefined, names: () => [], close() {} };
const emptyNotes: Notes = { home: null, zones: [], places: [] };
function event(text: string, extra: Partial<ChatEvent> = {}): ChatEvent {
  return { id: 1, kind: "player", senderUuid: "other", senderName: "Alex", text, signed: false, mentionsMe: false, self: false, ...extra };
}
function recordingBridge() {
  const sent: Array<{ text: string; at: number }> = [];
  const bridge: Bridge = {
    async rpc<T = unknown>(_method: string, params?: Record<string, unknown>): Promise<T> {
      sent.push({ text: String(params?.text), at: Date.now() });
      return { sent: true, asCommand: String(params?.text).startsWith("/") } as T;
    },
    health: async () => true,
  };
  return { sent, bridge };
}

test("addressing preserves authoritative flags, Unicode whole words, and self suppression", () => {
  let hooks = 0;
  const h = { ...emptyHost, onChat() { hooks++; return { ignore: true as const }; } };
  const { bridge } = recordingBridge();
  const chat = createChatPolicy(config, bridge, h, () => ctx);
  for (const text of ["BOT?", "hey, AI!", "SirWaffleshnoz?", "wafflebot"]) assert.deepEqual(chat.route(event(text)), { kind: "model", mustConsider: true });
  for (const text of ["robot", "stairs", "ébot", "boté", "bot_thing"]) assert.deepEqual(chat.route(event(text)), { kind: "ignore" });
  assert.deepEqual(chat.route(event("no local mention", { mentionsMe: true })), { kind: "model", mustConsider: true });
  assert.deepEqual(chat.route(event("hello", { kind: "whisper" })), { kind: "model", mustConsider: true });
  assert.deepEqual(chat.route(event("BOT", { self: true })), { kind: "ignore" });
  assert.equal(hooks, 12);
  assert.deepEqual(createChatPolicy(config, bridge, emptyHost, () => ctx).route(event("ambient")), { kind: "model", mustConsider: false });
});

test("chat splits, condenses, paces, and budgets /msg prefix without changing the recipient", async () => {
  const c = structuredClone(config);
  c.chat.maxLen = 40;
  const { bridge, sent } = recordingBridge();
  const chat = createChatPolicy(c, bridge, emptyHost, () => ctx);
  chat.route(event("hello", { kind: "whisper", senderName: "Alex" }));
  const result = await chat.reply("Alex", "food ".repeat(40), true);
  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(line => line.text.startsWith("/msg Alex ") && line.text.length <= 40));
  assert.ok(sent[1]!.text.endsWith("…"));
  assert.ok(sent[1]!.at - sent[0]!.at >= c.chat.minIntervalMs + 250);
  assert.equal((await chat.reply("unknown", "hello", true)).summary, "recipient ambiguous");
  assert.equal((await chat.reply("Alex other", "hello", true)).summary, "recipient ambiguous");
  assert.equal((await chat.reply("Alex", "hello", false)).ok, false);
  assert.equal((await chat.say("/home")).summary, "command_not_allowed");
  assert.equal((await chat.say(" #goto 0 0")).summary, "command_not_allowed");
  assert.equal(sent.length, 2);
});

test("two-line replies respect the mod guard and retry a rate-limited line once", async t => {
  for (const modDelayMs of [0, 300]) await t.test(`mod send delay ${modDelayMs} ms`, async () => {
    const c = structuredClone(config); c.chat.minIntervalMs = 40; c.chat.maxLen = 18;
    let lastModSend = -Infinity;
    const attempts: Array<{ text: string; at: number }> = [];
    const delivered: string[] = [];
    const bridge: Bridge = {
      health: async () => true,
      async rpc<T = unknown>(_method: string, params?: Record<string, unknown>): Promise<T> {
        const text = String(params?.text), at = Date.now();
        attempts.push({ text, at });
        if (at - lastModSend < c.chat.minIntervalMs) return { sent: false, rejected: "rate_limited" } as T;
        lastModSend = at + modDelayMs;
        delivered.push(text);
        return { sent: true } as T;
      },
    };
    const chat = createChatPolicy(c, bridge, emptyHost, () => ctx);
    chat.route(event("hello", { kind: "whisper", senderName: "Alex" }));
    const result = await chat.reply("Alex", "hello world", true);
    assert.equal(result.ok, true);
    assert.equal(attempts.length, modDelayMs > 250 ? 3 : 2);
    for (let i = 1; i < attempts.length; i++) {
      assert.ok(attempts[i]!.at - attempts[i - 1]!.at >= c.chat.minIntervalMs + 250);
    }
    if (modDelayMs > 250) assert.equal(attempts[2]!.text, attempts[1]!.text);
    assert.deepEqual(delivered, ["/msg Alex hello", "/msg Alex world"]);
  });
});

test("self echoes do not loop, and repeated other-player text stays distinct", async () => {
  const c = structuredClone(config); c.chat.minIntervalMs = 0;
  const { bridge } = recordingBridge();
  const chat = createChatPolicy(c, bridge, emptyHost, () => ctx);
  await chat.say("hello");
  assert.deepEqual(chat.route(event("<SirWaffleshnoz> hello", { kind: "system", senderName: null, senderUuid: null })), { kind: "ignore" });
  assert.deepEqual(chat.route(event("hello")), { kind: "model", mustConsider: false });
  assert.deepEqual(chat.route(event("hello", { id: 2, senderName: "Steve" })), { kind: "model", mustConsider: false });
});

test("UTF-16 reply budget never bisects astral characters; rejected sends are not successes", async () => {
  const c = structuredClone(config); c.chat.maxLen = 5; c.chat.minIntervalMs = 0;
  const { bridge, sent } = recordingBridge();
  const chat = createChatPolicy(c, bridge, emptyHost, () => ctx);
  await chat.say("😀😀😀😀😀");
  assert.ok(sent.every(line => line.text.length <= 5 && !/[\uD800-\uDBFF]$/.test(line.text)));
  let rejections = 0;
  const rejected: Bridge = { health: async () => true, rpc: async <T = unknown>() => {
    rejections++;
    return { sent: false, rejected: "rate_limited" } as T;
  } };
  assert.equal((await createChatPolicy(c, rejected, emptyHost, () => ctx).say("hi")).ok, false);
  assert.equal(rejections, 2);
});

test("queued replies older than 15 seconds are discarded", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const c = structuredClone(config); c.chat.minIntervalMs = 0;
  const { bridge, sent } = recordingBridge();
  const chat = createChatPolicy(c, bridge, emptyHost, () => ctx);
  const pending = chat.say("old reply");
  t.mock.timers.tick(15001);
  assert.equal((await pending).summary, "stale reply dropped");
  assert.equal(sent.length, 0);
});

test("heuristics priority, rewrite/veto, throwing isolation, and Windows cache-busted reload", async t => {
  const dir = await mkdtemp(join(tmpdir(), "qwencraft-policy-"));
  const logs: string[] = [];
  await writeFile(join(dir, "b.ts"), 'export default { name:"b", priority:10, onObservation:()=>["b"], onPlanProposed:call=>({name:call.name,args:{...call.args,b:true}}) };');
  await writeFile(join(dir, "a.ts"), 'export default { name:"a", priority:10, onObservation:()=>["a"], onChat:()=>({reply:"first"}), onTick:()=>({call:{name:"eat",args:{}},reason:"food"}) };');
  await writeFile(join(dir, "throw.ts"), 'export default { name:"throws", priority:20, onObservation:()=>{throw Error("boom")} };');
  const host = await createHeuristics(dir, msg => logs.push(msg));
  t.after(async () => { host.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(host.onObservation({}, ctx), ["a", "b"]);
  assert.deepEqual(host.names(), ["a", "b"]);
  host.onObservation({}, ctx); assert.equal(logs.filter(msg => msg.includes("disabled")).length, 1);
  assert.deepEqual(host.onPlanProposed({ name: "eat", args: {} }, {}, ctx), { name: "eat", args: { b: true } });
  assert.deepEqual(host.onChat(event("hi"), ctx), { reply: "first" });
  assert.equal(host.onTick({ food: 10, health: 20, pos: [0, 0, 0], hostilesNear: 0, paused: true }, ctx), undefined);
  assert.equal(host.onTick({ food: 10, health: 20, pos: [0, 0, 0], hostilesNear: 0, paused: false }, ctx)?.call.name, "eat");
  await writeFile(join(dir, "throw.ts"), 'export default { name:"reloaded", priority:20, onObservation:()=>["new"], onPlanProposed:()=>({veto:"no"}) };');
  await utimes(join(dir, "throw.ts"), new Date(), new Date(Date.now() + 1000));
  const deadline = Date.now() + 4000;
  while (!host.names().includes("reloaded") && Date.now() < deadline) await delay(25);
  assert.deepEqual(host.onObservation({}, ctx), ["new", "a", "b"]);
  assert.deepEqual(host.onPlanProposed({ name: "eat", args: {} }, {}, ctx), { veto: "no" });
  await writeFile(join(dir, "throw.ts"), 'not valid typescript =');
  await utimes(join(dir, "throw.ts"), new Date(), new Date(Date.now() + 2000));
  const errorDeadline = Date.now() + 4000;
  while (!logs.some(msg => msg.includes("reload failed")) && Date.now() < errorDeadline) await delay(25);
  assert.ok(logs.some(msg => msg.includes("reload failed")));
  assert.ok(host.names().includes("reloaded"));
});

test("history compacts only whole call/result groups and rejects orphans", () => {
  const history = createHistory(2);
  const assistant: ChatMessage = { role: "assistant", content: "<think>secret</think>working", tool_calls: [{ id: "a", type: "function", function: { name: "eat", arguments: "{}" } }, { id: "b", type: "function", function: { name: "observe", arguments: "{}" } }] };
  history.add({ role: "user", content: "trusted instruction" });
  history.add(assistant);
  history.add({ role: "tool", tool_call_id: "a", content: "ok" });
  assert.equal(history.compactable().length, 1);
  assert.throws(() => history.replaceOldest(2, "bad"));
  history.add({ role: "tool", tool_call_id: "b", content: "ok" });
  assert.throws(() => history.add({ role: "tool", tool_call_id: "b", content: "duplicate" }));
  history.add({ role: "assistant", content: "finished" });
  assert.equal(history.compactable().length, 4);
  assert.equal(history.messages()[1]!.content, "working");
  history.replaceOldest(4, "<think>secret</think>observed food increase");
  assert.equal(history.summary, "observed food increase");
  assert.deepEqual(history.messages(), [{ role: "assistant", content: "finished" }]);
  assert.throws(() => history.add({ role: "tool", tool_call_id: "unknown", content: "orphan" }));
});

test("home uses saved-anchor precedence, horizontal distance, and a fail-closed missing anchor", () => {
  assert.equal(horizontalDistance([0, -100, 0], [3, 900, 4]), 5);
  assert.equal(withinHome(config, emptyNotes, [256, 1000, 0]), true);
  assert.equal(withinHome(config, emptyNotes, [257, 64, 0]), false);
  assert.equal(withinHome(config, { ...emptyNotes, home: [1000, 0, 0] }, [1000, 999, 0]), true);
  assert.equal(withinHome({ ...config, home: null }, emptyNotes, [0, 0, 0]), false);
  assert.equal(withinHome(config, emptyNotes, [NaN, 0, 0]), false);
});

test("notes writes are serialized/atomic, corrupt reads preserve data, and server mismatch archives", async t => {
  const dir = await mkdtemp(join(tmpdir(), "qwencraft-notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "notes.json");
  const notes = await createNotesStore(path, config);
  await Promise.all([notes.update(n => { n.home = [1, 2, 3]; }), notes.update(n => { n.zones.push({ name: "own", min: [0, 0, 0], max: [2, 2, 2] }); })]);
  const saved = await readFile(path, "utf8");
  assert.deepEqual((await createNotesStore(path, config)).get(), notes.get());
  await assert.rejects(notes.update(n => { n.home = [NaN, 0, 0]; }));
  assert.equal(await readFile(path, "utf8"), saved);
  const snapshot = notes.get(); snapshot.places.push({ name: "not saved", kind: "place", note: "", pos: null, dimension: null, at: 0 });
  assert.equal(notes.get().places.length, 0);
  const other = await createNotesStore(path, { ...config, server: { host: "other", port: 25570 } });
  assert.deepEqual(other.get(), emptyNotes);
  assert.ok((await readdir(dir)).some(file => file.endsWith(".bak")));
  await writeFile(path, "{broken");
  await assert.rejects(createNotesStore(path, config), /memory read failed/);
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("observations aggregate inventory, label failures/truncation and keep client world sources", async () => {
  const seen: string[] = [];
  const values: Record<string, unknown> = {
    "session.info": { worldId: "mp:localhost", dimension: "minecraft:overworld" },
    "player.getState": { x: 0, y: 64, z: 0, health: 20, food: 14 },
    "player.getInventory": { hotbar: [{ id: "minecraft:apple", count: 2, slot: 0 }], main: [{ id: "minecraft:apple", count: 3, slot: 9 }], armor: [], offhand: { empty: true } },
    "player.getEquipment": { mainHand: { id: "minecraft:apple", count: 2 } },
    "perception.scan": { chunks: Array.from({ length: 80 }, (_, cx) => ({ cx, cz: 0, y: 64, counts: { "minecraft:oak_log": 99 } })), pois: [] },
    "perception.entities": { entities: [{ kind: "hostile", uuid: "mob", x: 1, y: 64, z: 1, distance: 1 }] },
    "qc.world.state": { dimension: "minecraft:overworld", dayTime: 100, gameTime: 100, raining: false, thundering: false },
    "qc.control.state": { paused: false, reason: null }, "qc.baritone.status": { active: false },
  };
  const env: SkillEnv = { config, notes: { get: () => emptyNotes, update: async () => {} }, events: { on: () => () => {}, next: async () => null }, signal: new AbortController().signal, log() {}, chat: createChatPolicy(config, recordingBridge().bridge, emptyHost, () => ctx),
    bridge: { health: async () => true, async rpc<T = unknown>(method: string): Promise<T> { seen.push(method); if (method === "player.getStatusEffects") throw Error("unavailable"); return values[method] as T; } },
  };
  const obs = await observe(env, { goal: "food", lastResult: null, recentChat: [event("hi")], hints: [] });
  const inventory = obs.inventory as Record<string, unknown>;
  assert.deepEqual(inventory.counts, { "minecraft:apple": 5 });
  assert.equal(obs.effects, null);
  const metadata = obs.metadata as { unavailable: Record<string, string>; omitted: string[] };
  assert.equal(metadata.unavailable.effects, "unavailable");
  assert.ok(metadata.omitted.includes("terrain"));
  assert.ok(seen.includes("qc.world.state") && !seen.some(name => name.startsWith("world.")));
  assert.ok(JSON.stringify(obs).length < 16000);
  assert.deepEqual(await tickSnapshot(env), { health: 20, food: 14, pos: [0, 64, 0], hostilesNear: 1, paused: false });
});

test("redaction preserves code identifiers, repo-relative names and the DGX Spark product phrase", () => {
  for (const text of [
    'call.name === "explore"',
    "env.signal QcState.protect call.args",
    "docs/30-controller.md controller/chat-policy.ts heuristics/example-food.ts",
    "mod/src/main/java/dev/qwencraft/QcState.java",
    "a DGX Spark",
    "served by vLLM on a DGX Spark",
    "a dgx spark",
  ]) assert.equal(redact(text), text);
  assert.ok(redact(ABOUT_ME).includes("served by vLLM on a DGX Spark"));
});

test("redaction still hides host tokens, URLs, IP literals, credentials and absolute paths", () => {
  for (const text of [
    "http://192.168.100.2:8000/v1",
    "127.0.0.1:25599",
    "[2001:db8::1]:25599",
    "fe80::1%eth0",
    "localhost",
    "spark",
    "spark-wifi",
    "spark-01",
    "waffle-house",
    "waffle-spark",
    "raycraft.ddnsfree.com",
    "example.net",
    "example.org",
    "example.io",
    "bridge.local",
    "bridge.lan",
    "bridge:3000",
    "https://example.com/private",
    "ssh://spark/private",
    "ws://localhost:3000/events",
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
    "password=hunter2",
    "token=shortsecret",
    "aabbccddeeff001122334455",
    "aGVsbG93b3JsZHNlY3JldDEyMzQ=",
    "C:/Users/jlyon/...",
    "C:\\Users\\jlyon\\secret",
    "D:/qwencraft/notes.json",
    "/home/other/.ssh/key",
    "/etc/passwd",
    "jlyon",
  ]) assert.equal(redact(text), "[redacted]", text);
  assert.equal(redact("ssh spark"), "ssh [redacted]");
  assert.equal(redact("spark:"), "[redacted]:");
  assert.equal(redact("ssh spark."), "ssh [redacted].");
  assert.equal(redact("Connect to localhost."), "Connect to [redacted].");
  assert.equal(redact("a DGX Spark; ssh spark"), "a DGX Spark; ssh [redacted]");
});

test("self disclosure redacts addresses, hostnames, credentials and local paths but keeps game coordinates/code names", async t => {
  const unsafe = "192.168.100.2 127.0.0.1 [2001:db8::1] ::1 :: fe80::1%eth0 localhost:25599 waffle-house waffle-spark spark-01 bridge.example.com:8000 11434 Bearer abcdefghijklmnopqrstuvwxyz012345 password=hunter2 token=shortsecret C:\\Users\\jlyon\\secret D:/qwencraft/notes.json /home/other/.ssh/key /etc/passwd jlyon aabbccddeeff001122334455 aGVsbG93b3JsZHNlY3JldDEyMzQ=";
  const safe = redact(unsafe);
  for (const value of ["192.168", "127.0", "2001:db8", "::1", "::", "fe80", "eth0", "localhost", "25599", "waffle", "spark", "example.com", "8000", "11434", "hunter2", "shortsecret", "Users", "jlyon", "/home", "/etc", "aabbccdd", "aGVsbG93"]) assert.ok(!safe.includes(value), value);
  assert.ok(safe.includes("[redacted]"));
  assert.equal(redact("home [8000,64,11434] zone [1,2,3] controller/chat-policy.ts"), "home [8000,64,11434] zone [1,2,3] controller/chat-policy.ts");
  assert.ok(ABOUT_ME.includes("Qwen3.8-Flash-Next") && ABOUT_ME.includes("Jared") && ABOUT_ME.length < 4800);
  const c = structuredClone(config); c.chat.minIntervalMs = 0;
  const { bridge, sent } = recordingBridge();
  const chat = createChatPolicy(c, bridge, emptyHost, () => ctx);
  await chat.say("The bridge is http://127.0.0.1:25599 and password=hunter2.");
  assert.ok(sent.every(line => !line.text.includes("127.0.0.1") && !line.text.includes("hunter2")));
  chat.route(event("private", { kind: "whisper", senderName: "Alex" }));
  await chat.reply("Alex", "Model endpoint localhost:8000", true);
  assert.ok(sent.at(-1)!.text.startsWith("/msg Alex ") && !sent.at(-1)!.text.includes("localhost"));
  const root = await mkdtemp(join(tmpdir(), "qwencraft-selfinfo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs", "evidence"), { recursive: true });
  await mkdir(join(root, "controller"));
  await writeFile(join(root, "docs", "design.md"), "Baritone navigation uses localhost:8000.\\nPlanner is served by vLLM on a DGX Spark.");
  await writeFile(join(root, "controller", "loop.ts"), 'const baritone = "127.0.0.1"; if (call.name === "explore") {}');
  await writeFile(join(root, "docs", "evidence", "private.md"), "Baritone password=do-not-search");
  const info = await searchHarness("How does Baritone navigation work?", root);
  assert.ok(info.includes("docs/design.md:") && info.includes("controller/loop.ts:"));
  assert.ok(info.includes("a DGX Spark") && info.includes('call.name === "explore"'));
  assert.ok(!info.includes("localhost") && !info.includes("127.0.0.1") && !info.includes("do-not-search") && info.length <= 1500);
});
