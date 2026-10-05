import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolsForLlm, validateArguments } from "../tools.ts";
import { MAX_PATH_FAILURES, blocksForItem, chooseRecipe, dropForBlock, executeSkill, goalSatisfied, inventoryDelta, isProtected, itemCount, itemId } from "../skills.ts";
import type { Config, GameEvent, Notes, SkillEnv } from "../types.ts";

const expected = "observe look_screenshot go_to go_to_player follow_player explore collect mine craft smelt place_block break_block equip eat attack chest_deposit chest_withdraw drop chat_say chat_reply run_command remember recall set_goal finish_goal stop harness_info".split(" ");

test("curated registry and OpenAI schema contain exactly the operator-approved tools", () => {
  assert.deepEqual(TOOLS.map(t => t.name), expected);
  assert.equal(new Set(TOOLS.map(t => t.name)).size, 27);
  assert.equal(TOOLS.some(tool => tool.name === "wait"), false);
  for (const tool of TOOLS) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
    const required = tool.parameters.required as string[];
    assert.ok(required.every(key => Object.hasOwn(properties, key)));
    for (const property of Object.values(properties)) assert.ok(["string", "number", "integer", "boolean"].includes(String(property.type)));
  }
  const modelTools = toolsForLlm(TOOLS);
  assert.equal(modelTools.length, 27);
  assert.deepEqual(modelTools[0], { type: "function", function: { name: TOOLS[0]!.name, description: TOOLS[0]!.description, parameters: TOOLS[0]!.parameters } });
});

test("trust boundary rejects unknown fields, nonfinite coordinates, fractional counts and invalid slots", () => {
  const find = (name: string) => TOOLS.find(t => t.name === name)!.parameters;
  assert.equal(validateArguments(find("go_to"), { x: 1, z: 2 }), null);
  assert.match(validateArguments(find("go_to"), { x: NaN, z: 2 })!, /x/);
  assert.match(validateArguments(find("go_to"), { x: Infinity, z: 2 })!, /x/);
  assert.match(validateArguments(find("go_to"), { x: 1, z: 2, method: "command.run" })!, /unknown/);
  assert.match(validateArguments(find("collect"), { item: "oak_log", count: 1.5 })!, /count/);
  assert.match(validateArguments(find("collect"), { item: "oak_log", count: 0 })!, /count/);
  assert.match(validateArguments(find("place_block"), { item: "dirt", x: 1.5, y: 0, z: 0 })!, /x/);
  assert.match(validateArguments(find("equip"), { item: "dirt", slot: "head" })!, /slot/);
  assert.match(validateArguments(find("remember"), { kind: "place", name: "", note: "here" })!, /name/);
});

test("inventory quantities aggregate slots and count NEW output, not final inventory", () => {
  const before = { hotbar: [{ id: "minecraft:oak_log", count: 5, slot: 0 }], main: [{ id: "minecraft:oak_log", count: 8, slot: 12 }], armor: [], offhand: { id: "minecraft:oak_log", count: 2 } };
  const after = { ...before, main: [{ id: "minecraft:oak_log", count: 12, slot: 12 }] };
  assert.equal(itemCount(before, "minecraft:oak_log"), 15);
  assert.equal(inventoryDelta(before, after, "minecraft:oak_log"), 4);
  assert.equal(itemCount(before, "minecraft:oak_log") + 4, 19);
  assert.equal(inventoryDelta(after, before, "minecraft:oak_log"), -4);
});

test("drop mappings cover log variants, cobblestone and raw iron and reject unsupported drops", () => {
  assert.equal(dropForBlock("oak_log"), "minecraft:oak_log");
  assert.equal(dropForBlock("pale_oak_log"), "minecraft:pale_oak_log");
  assert.equal(dropForBlock("stone"), "minecraft:cobblestone");
  assert.equal(dropForBlock("iron_ore"), "minecraft:raw_iron");
  assert.equal(dropForBlock("deepslate_iron_ore"), "minecraft:raw_iron");
  assert.deepEqual(blocksForItem("raw_iron"), ["minecraft:iron_ore", "minecraft:deepslate_iron_ore"]);
  for (const [ore, drop] of [["copper", "raw_copper"], ["lapis", "lapis_lazuli"], ["redstone", "redstone"]]) {
    assert.equal(dropForBlock(`${ore}_ore`), `minecraft:${drop}`);
    assert.equal(dropForBlock(`deepslate_${ore}_ore`), `minecraft:${drop}`);
  }
  assert.equal(dropForBlock("nether_gold_ore"), "minecraft:gold_nugget");
  assert.equal(dropForBlock("ancient_debris"), "minecraft:ancient_debris");
  assert.equal(dropForBlock("oak_leaves"), null);
  assert.equal(dropForBlock("mod:ore"), null);
  assert.throws(() => itemId("oak log"), /invalid/);
});

test("recipe choice requires observed unlocked matching output and recipe type", () => {
  const recipes = [
    { known: false, type: "crafting", ref: "recipe:locked", result: { id: "minecraft:stick", count: 4 }, ingredients: [["minecraft:oak_planks"]] },
    { known: true, type: "smelting", ref: "display:1", result: { id: "minecraft:stick", count: 1 }, ingredients: [["minecraft:oak_log"]] },
    { known: true, type: "crafting", ref: "display:2", result: { id: "minecraft:stick", count: 4 }, ingredients: [["minecraft:oak_planks"], ["minecraft:oak_planks"]] },
  ];
  assert.equal(chooseRecipe({ recipes }, "minecraft:stick", "crafting")?.ref, "display:2");
  assert.equal(chooseRecipe({ recipes }, "minecraft:diamond", "crafting"), null);
});

test("goal postconditions match GoalXZ, GoalBlock and integer-block GoalNear semantics", () => {
  assert.equal(goalSatisfied([10.4, 500, -2.1], { x: 10, z: -3, range: 200 }), true);
  assert.equal(goalSatisfied([10.4, 65, -2.1], { x: 10, y: 64, z: -3 }), false);
  assert.equal(goalSatisfied([10.4, 64.9, -2.1], { x: 10, y: 64, z: -3 }), true);
  assert.equal(goalSatisfied([13.1, 64.9, -2.1], { x: 10, y: 64, z: -3, range: 3 }), true);
  assert.equal(goalSatisfied([13.1, 65, -2.1], { x: 10, y: 64, z: -3, range: 3 }), false);
});

test("break protection is natural-allowlist plus inclusive configured and remembered zones", () => {
  const c = { protect: { naturalBlocks: ["minecraft:stone"], zones: [{ name: "base", min: [0, 0, 0], max: [4, 4, 4] }] } } as Config;
  const notes: Notes = { home: null, zones: [{ name: "remembered", min: [10, 10, 10], max: [11, 11, 11] }], places: [] };
  assert.equal(isProtected(c, notes, "minecraft:stone", [5, 4, 4]), false);
  assert.equal(isProtected(c, notes, "minecraft:stone", [4, 4, 4]), false);
  assert.equal(isProtected(c, notes, "minecraft:stone", [10, 10, 10]), false);
  assert.equal(isProtected(c, notes, "minecraft:crafting_table", [4, 4, 4]), false);
  assert.equal(isProtected(c, notes, "minecraft:crafting_table", [10, 10, 10]), false);
  assert.equal(isProtected(c, notes, "minecraft:crafting_table", [100, 0, 0]), true);
});

test("break_block allows protected blocks only with an exact tracked position and id", async () => {
  const target = { x: 1, y: 64, z: 0 };
  const id = "minecraft:cobblestone";
  for (const blocks of [
    [{ ...target, id }],
    [],
    [{ ...target, x: 2, id }],
    [{ ...target, y: 65, id }],
    [{ ...target, z: 1, id }],
    [{ ...target, id: "minecraft:stone" }],
    null,
  ]) {
    let broken = false, checked = false;
    const unused = (): never => { throw new Error("unexpected test dependency"); };
    const env: SkillEnv = {
      bridge: {
        health: async () => true,
        async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
          if (method === "perception.blocks") return { blocks: [{ ...target, loaded: true, id: broken ? "minecraft:air" : id, air: broken, canHarvest: true, hardness: 2, bestSlot: 0 }] } as T;
          if (method === "qc.placed.near") {
            checked = true;
            assert.deepEqual(params, { ...target, radius: 0 });
            if (blocks === null) throw new Error("unavailable");
            return { blocks } as T;
          }
          if (method === "player.getState") return { x: 0, y: 64, z: 0 } as T;
          if (method === "interact.breakBlock") broken = true;
          return {} as T;
        },
      },
      config: { home: null, selfGoal: { radius: 256 }, protect: { naturalBlocks: ["minecraft:stone"], zones: [] } } as unknown as Config,
      notes: { get: () => ({ home: [0, 64, 0], zones: [], places: [] }), update: unused },
      events: { on: unused, next: unused },
      chat: { route: unused, say: unused, reply: unused },
      signal: new AbortController().signal,
      log: unused,
    };
    const answer = await TOOLS.find(t => t.name === "break_block")!.run(target, env);
    const owned = blocks?.some(b => b.x === target.x && b.y === target.y && b.z === target.z && b.id === id) ?? false;
    assert.equal(checked, true);
    assert.equal(answer.ok, owned);
    assert.equal(broken, owned);
    assert.equal(answer.summary, owned ? `Removed ${id}` : "protected block");
  }
});

test("finish_goal accepts free-form summaries after success or an explicit abandoned prefix", async () => {
  let sent = true;
  const notes: Notes = { home: null, zones: [], places: [] };
  const unused = (): never => { throw new Error("unexpected test dependency"); };
  const env: SkillEnv = {
    bridge: {
      health: async () => true,
      async rpc<T = unknown>(method: string): Promise<T> {
        assert.equal(method, "qc.chat.send");
        return { sent, rejected: sent ? undefined : "rate_limited" } as T;
      },
    },
    config: { commands: { allowlist: ["/sethome"] } } as Config,
    notes: { get: () => notes, update: unused },
    events: { on: unused, next: unused },
    chat: { route: unused, say: unused, reply: unused },
    signal: new AbortController().signal,
    log: unused,
  };
  const run = (name: string, args: Record<string, unknown>) => TOOLS.find(t => t.name === name)!.run(args, env);
  const rejected = "no successful tool outcome recorded for this goal; act first or finish with 'abandoned: <reason>'";
  assert.equal((await run("set_goal", { text: "Set a home" })).ok, true);
  assert.deepEqual(await run("finish_goal", { summary: "Home is ready." }), { ok: false, summary: rejected, observedDelta: {} });
  sent = false;
  assert.equal((await run("run_command", { command: "/sethome" })).ok, false);
  assert.equal((await run("finish_goal", { summary: "Home is ready." })).ok, false);
  sent = true;
  assert.equal((await run("run_command", { command: "/sethome" })).ok, true);
  const summary = "I have established our home.";
  const finished = await run("finish_goal", { summary });
  assert.equal(finished.ok, true);
  assert.equal((finished.observedDelta as Record<string, unknown>).goalFinished, summary);
  assert.equal((await run("finish_goal", { summary })).ok, false);

  assert.equal((await run("set_goal", { text: "Set another home" })).ok, true);
  assert.equal((await run("run_command", { command: "/sethome" })).ok, true);
  assert.equal((await run("set_goal", { text: "Build a shelter" })).ok, true);
  for (const summary of ["Shelter complete.", "I abandoned the search.", "cancelled", " abandoned: no supplies"]) {
    assert.deepEqual(await run("finish_goal", { summary }), { ok: false, summary: rejected, observedDelta: {} });
  }
  for (const summary of ["abandoned: no supplies", "ABANDONED: unsafe location"]) {
    const finished = await run("finish_goal", { summary });
    assert.equal(finished.ok, true);
    assert.equal((finished.observedDelta as Record<string, unknown>).goalFinished, summary);
  }
});

test("a job that Baritone keeps retrying ends after repeated path failures instead of at the timeout", async () => {
  const notes: Notes = { home: [0, 64, 0], zones: [], places: [] };
  const unused = (): never => { throw new Error("unexpected test dependency"); };
  const listeners: Array<(e: GameEvent) => void> = [];
  let stopped = false, eventId = 0;
  const env: SkillEnv = {
    bridge: {
      health: async () => true,
      async rpc<T = unknown>(method: string): Promise<T> {
        const responses: Record<string, unknown> = {
          "player.getState": { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
          "qc.baritone.goto": { started: true, taskId: "t1" },
          "qc.baritone.status": { active: !stopped, taskId: "t1", kind: "goto" },
          "qc.baritone.stop": { stopped: true },
          "player.getInventory": { hotbar: [], main: [], armor: [], offhand: {} },
        };
        if (method === "qc.baritone.stop") stopped = true;
        return (responses[method] ?? {}) as T;
      },
    },
    config: { home: null, selfGoal: { radius: 256 }, protect: { naturalBlocks: [], zones: [] } } as unknown as Config,
    notes: { get: () => notes, update: unused },
    events: {
      on(_type, fn) { listeners.push(fn); return () => {}; },
      async next(type) {
        // Baritone reports a fresh calc_failed for the same task on every event poll.
        for (const fn of listeners) fn({ id: ++eventId, type, gameTime: 0, data: { taskId: "t1", kind: "goto", state: "calc_failed" } });
        return null;
      },
    },
    chat: { route: unused, say: unused, reply: unused },
    signal: new AbortController().signal,
    log: () => {},
  };
  const result = await TOOLS.find(t => t.name === "go_to")!.run({ x: 20, z: 20 }, env);
  assert.equal(result.ok, false);
  assert.match(result.summary, new RegExp(`path calculation failed ${MAX_PATH_FAILURES} times in a row`));
  assert.equal(stopped, true);
});

function oreJob(pickaxe: string, options: {block?: string; stepMs?: number; moving?: boolean; acquireAt?: number; count?: number} = {}) {
  let now = 0, stopped = false, started = false, scanned = false;
  const unused = (): never => {throw new Error("unexpected test dependency");};
  const env: SkillEnv = {
    bridge: {health: async () => true, async rpc<T>(method: string): Promise<T> {
      if (method === "perception.scan" || method === "perception.blocks") {scanned = true; throw new Error("ore scan must not be required");}
      if (method === "qc.baritone.mine") started = true;
      if (method === "qc.baritone.stop") stopped = true;
      const responses: Record<string, unknown> = {
        "player.getState": {x: options.moving ? now / 30000 : 0, y: 64, z: 0, dimension: "minecraft:overworld"},
        "player.getInventory": {selectedSlot: 0, hotbar: [{id: `minecraft:${pickaxe}_pickaxe`, count: 1, slot: 0},
          ...(now >= (options.acquireAt ?? Infinity) ? [{id: dropForBlock(options.block ?? "iron_ore"), count: options.count ?? 1, slot: 1}] : [])], main: [], armor: [], offhand: {}},
        "qc.baritone.mine": {started: true, taskId: "ore-task"}, "qc.baritone.status": {active: started && !stopped, taskId: "ore-task"},
        "qc.baritone.stop": {stopped: true},
      };
      return (responses[method] ?? {}) as T;
    }},
    config: {home: null, selfGoal: {radius: 256}, protect: {naturalBlocks: [itemId(options.block ?? "iron_ore"), "minecraft:deepslate_iron_ore"], zones: []}} as unknown as Config,
    notes: {get: () => ({home: [0,64,0], zones: [], places: []}), update: unused},
    events: {on() {return () => {};}, async next() {now += options.stepMs ?? 45000; return null;}},
    chat: {route: unused, say: unused, reply: unused}, signal: new AbortController().signal, log() {},
  };
  return {env, now: () => now, state: () => ({stopped, started, scanned})};
}

test("ore mining needs a sufficient pickaxe but no nearby scanned ore", async () => {
  for (const pickaxe of ["wooden", "golden", "stone", "iron", "diamond", "netherite"]) {
    const job = oreJob(pickaxe, {acquireAt: 45000});
    const answer = await executeSkill("mine", {block: "iron_ore", count: 1}, job.env, job.now);
    const sufficient = !["wooden", "golden"].includes(pickaxe);
    assert.equal(answer.ok, sufficient);
    assert.equal(job.state().started, sufficient); assert.equal(job.state().scanned, false);
    if (!sufficient) assert.equal(answer.summary, "need a stone pickaxe or better to mine minecraft:iron_ore");
  }
});

test("a variable-yield ore succeeds from its actual drop inventory delta", async () => {
  const job = oreJob("stone", {block: "lapis_ore", acquireAt: 45000, count: 9});
  const answer = await executeSkill("mine", {block: "lapis_ore", count: 1}, job.env, job.now);
  assert.equal(answer.ok, true); assert.equal(answer.summary, "Acquired 9 minecraft:lapis_lazuli");
  assert.equal(job.state().scanned, false);
});

test("a mining job with no position or target-inventory progress stops after 45 seconds", async () => {
  const job = oreJob("stone");
  const answer = await executeSkill("collect", {item: "raw_iron", count: 1}, job.env, job.now);
  assert.equal(answer.ok, false);
  assert.equal(answer.summary, "stalled: no movement or inventory change for 45 s");
  assert.equal(job.now(), 45000); assert.equal(job.state().stopped, true);
});

test("ore budgets use the five-minute floor, forty seconds per item and fifteen-minute ceiling", async () => {
  for (const [count, budget] of [[1,300000], [10,400000], [30,900000]] as const) {
    const job = oreJob("stone", {stepMs: 10000, moving: true, acquireAt: budget - 10000, count});
    const answer = await executeSkill("collect", {item: "raw_iron", count}, job.env, job.now);
    assert.equal(answer.ok, true, answer.summary);
    assert.equal(job.now(), budget - 10000);
    const expired = oreJob("stone", {stepMs: 10000, moving: true});
    const failure = await executeSkill("mine", {block: "iron_ore", count}, expired.env, expired.now);
    assert.equal(failure.ok, false); assert.equal(expired.now(), budget);
    assert.equal(expired.state().stopped, true);
  }
});
