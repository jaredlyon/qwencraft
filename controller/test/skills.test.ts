import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolsForLlm, validateArguments } from "../tools.ts";
import { MAX_PATH_FAILURES, SWORD_HOTBAR, blocksForItem, chooseRecipe, dropForBlock, executeSkill, goalSatisfied, inventoryDelta, isProtected, itemCount, itemId, oreHeight } from "../skills.ts";
import type { SkillSleep } from "../skills.ts";
import type { Config, GameEvent, Notes, SkillEnv, ToolResult } from "../types.ts";

const expected = "observe look_screenshot go_to go_to_player follow_player explore collect mine craft smelt repair_tool place_block break_block equip eat attack chest_deposit chest_withdraw drop chat_say chat_reply run_command remember recall set_goal finish_goal stop harness_info".split(" ");

test("curated registry and OpenAI schema contain exactly the operator-approved tools", () => {
  assert.deepEqual(TOOLS.map(t => t.name), expected);
  assert.equal(new Set(TOOLS.map(t => t.name)).size, 28);
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
  assert.equal(modelTools.length, 28);
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

function oreJob(pickaxe: string, options: {block?: string; stepMs?: number; moving?: boolean; acquireAt?: number; count?: number; startY?: number; pickaxeSlot?: number; selected?: number} = {}) {
  let now = 0, stopped = false, started = false, scanned = false, descended = false;
  const calls: Array<{method: string; params: unknown}> = [];
  const branchY = oreHeight(itemId(options.block ?? "iron_ore")) ?? 64;
  const unused = (): never => {throw new Error("unexpected test dependency");};
  const env: SkillEnv = {
    bridge: {health: async () => true, async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({method, params});
      if (method === "perception.scan" || method === "perception.blocks") {scanned = true; throw new Error("ore scan must not be required");}
      if (method === "qc.baritone.mine") {started = true; stopped = false;}
      if (method === "qc.baritone.goto") {descended = true; stopped = false;}
      if (method === "qc.baritone.stop") stopped = true;
      const responses: Record<string, unknown> = {
        "player.getState": {x: options.moving ? now / 30000 : 0, y: descended ? branchY : options.startY ?? branchY, z: 0, dimension: "minecraft:overworld"},
        "qc.baritone.goto": {started: true, taskId: "down-task"},
        "player.getInventory": {selectedSlot: options.selected ?? 0, hotbar: [{id: `minecraft:${pickaxe}_pickaxe`, count: 1, slot: options.pickaxeSlot ?? 0},
          ...(now >= (options.acquireAt ?? Infinity) ? [{id: dropForBlock(options.block ?? "iron_ore"), count: options.count ?? 1, slot: 1}] : [])], main: [], armor: [], offhand: {}},
        "qc.baritone.mine": {started: true, taskId: "ore-task"}, "qc.baritone.status": {active: (started || descended) && !stopped, taskId: started ? "ore-task" : "down-task"},
        "qc.baritone.stop": {stopped: true},
      };
      return (responses[method] ?? {}) as T;
    }},
    config: {home: null, selfGoal: {radius: 256}, protect: {naturalBlocks: [itemId(options.block ?? "iron_ore"), "minecraft:deepslate_iron_ore"], zones: []}} as unknown as Config,
    notes: {get: () => ({home: [0,64,0], zones: [], places: []}), update: unused},
    events: {on() {return () => {};}, async next() {now += options.stepMs ?? 45000; return null;}},
    chat: {route: unused, say: unused, reply: unused}, signal: new AbortController().signal, log() {},
  };
  return {env, now: () => now, calls, state: () => ({stopped, started, scanned})};
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

test("ore mining digs down to the ore's height first, then branch-mines at that height", async () => {
  assert.equal(oreHeight("minecraft:deepslate_iron_ore"), 16);
  assert.equal(oreHeight("minecraft:emerald_ore"), undefined);
  const job = oreJob("stone", {acquireAt: 45000, startY: 64});
  const answer = await executeSkill("mine", {block: "iron_ore", count: 1}, job.env, job.now);
  assert.equal(answer.ok, true, answer.summary);
  const goto = job.calls.findIndex(c => c.method === "qc.baritone.goto");
  const mine = job.calls.findIndex(c => c.method === "qc.baritone.mine");
  assert.ok(goto >= 0 && mine > goto);
  assert.deepEqual(job.calls[goto]!.params, { y: 16 });
  assert.equal((job.calls[mine]!.params as {y?: number}).y, 16);
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

test("pulling a tool from the main inventory never displaces the sword in hotbar slot 8", async () => {
  const job = oreJob("stone", {acquireAt: 45000, pickaxeSlot: 20, selected: SWORD_HOTBAR});
  const answer = await executeSkill("mine", {block: "iron_ore", count: 1}, job.env, job.now);
  assert.equal(answer.ok, true, answer.summary);
  const swap = job.calls.find(c => c.method === "inventory.swapSlots");
  assert.deepEqual(swap?.params, {slotA: 20, slotB: 0});
  assert.ok(!job.calls.some(c => c.method === "inventory.swapSlots" && (c.params as {slotB?: number}).slotB === SWORD_HOTBAR));
});

type FakeStack = { slot: number; id: string; count: number; damage?: number };
type FakeOptions = { cost?: number; xp?: number; noMaterial?: boolean; pickupFull?: boolean; noPickup?: boolean; craftFails?: boolean; noResult?: boolean; armor?: boolean; noArmorSlot?: boolean; keepXp?: boolean; footArrival?: boolean };
function inventorySkill(kind: "craft" | "smelt" | "repair_tool", options: FakeOptions = {}) {
  const station = kind === "craft" ? "minecraft:crafting_table" : kind === "smelt" ? "minecraft:furnace" : "minecraft:anvil";
  const output = kind === "craft" ? "minecraft:stone_pickaxe" : kind === "smelt" ? "minecraft:iron_ingot" : "minecraft:diamond_sword";
  const input = kind === "craft" ? "minecraft:oak_planks" : kind === "smelt" ? "minecraft:raw_iron" : "minecraft:diamond";
  let stacks: FakeStack[] = kind === "repair_tool" ? [{ slot: 5, id: output, count: 1, damage: 800 }, { slot: 6, id: output, count: 1, damage: 100 }] :
    [{ slot: 0, id: station, count: 1 }];
  if (options.armor) stacks = [];
  if (!options.noMaterial) stacks.push({ slot: 9, id: input, count: kind === "craft" ? 5 : kind === "smelt" ? 1 : 3 });
  if (kind === "smelt") stacks.push({ slot: 10, id: "minecraft:coal", count: 2 });
  if (options.noArmorSlot) for (let slot = 9; slot <= 35; slot++) if (!stacks.some(stack => stack.slot === slot)) stacks.push({ slot, id: "minecraft:dirt", count: 64 });
  let armor = options.armor ? [{ slot: "legs", id: output, count: 1, damage: 800 }] : [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const notes: Notes = { home: [0, 64, 0], zones: [], places: [] };
  let placed = kind === "repair_tool", opened = false, broken = false, used = false, xp = options.xp ?? 10;
  let cursor: FakeStack | null = null, slots: FakeStack[] = [];
  let x = options.footArrival ? 10 : 0, z = 0, stopped = false;
  const insert = (stack: FakeStack) => {
    const existing = stacks.find(s => s.id === stack.id && s.damage === stack.damage && s.count < 64);
    if (existing) existing.count += stack.count;
    else { const empty = Array.from({ length: 36 }, (_, i) => i).find(slot => !stacks.some(s => s.slot === slot)); if (empty === undefined) throw new Error("inventory full"); stacks.push({ ...stack, slot: empty }); }
  };
  const env: SkillEnv = {
    bridge: { health: async () => true, async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      if (method === "session.info") return { worldId: "bench", dimension: "minecraft:overworld" } as T;
      if (method === "player.getState") return { x, y: 64, z, dimension: "minecraft:overworld", xpLevel: xp } as T;
      if (method === "player.getInventory") return { selectedSlot: 0, hotbar: stacks.filter(s => s.slot < 9), main: stacks.filter(s => s.slot >= 9), armor, offhand: {} } as T;
      if (method === "qc.inventory.tools") return { tools: [...stacks, ...armor].filter(s => s.id === output && kind === "repair_tool").map(s => ({ ...s, damage: s.damage ?? 0, maxDamage: 1561, enchantments: ["minecraft:sharpness 3"], repairCost: 0, repairWith: [input] })) } as T;
      if (method === "perception.scan") return { found: [] } as T;
      if (method === "perception.blocks") {
        const p = (params.positions as Array<Record<string, number>>)[0]!;
        const isStation = p.x === 1 && p.y === 64 && p.z === 0;
        return { blocks: [{ ...p, loaded: true, id: isStation && placed ? station : p.y < 64 ? "minecraft:stone" : "minecraft:air", air: isStation ? !placed : p.y >= 64, canHarvest: true, hardness: 2, bestSlot: 0 }] } as T;
      }
      if (method === "qc.placed.near") return { blocks: placed ? [{ x: 1, y: 64, z: 0, id: station }] : [] } as T;
      if (method === "player.getEquipment") return { mainHand: { id: station } } as T;
      if (method === "interact.placeBlock") { placed = true; stacks = stacks.filter(s => s.id !== station); }
      if (method === "interact.breakBlock") { assert.equal(slots.length, 0); placed = false; broken = true; if (!options.noPickup) insert({ slot: 0, id: station, count: 1 }); }
      if (method === "qc.baritone.goto") { x = options.footArrival ? 4.9 : 1.5; z = options.footArrival ? 0 : 0.5; stopped = false; return { started: true, taskId: "pickup" } as T; }
      if (method === "qc.baritone.stop") { stopped = true; return { stopped: true } as T; }
      if (method === "qc.baritone.status") return { active: !stopped, taskId: "pickup" } as T;
      if (method === "inventory.swapSlots") {
        const from = armor[0]; assert.ok(from); stacks.push({ ...from, slot: Number(params.slotB) }); armor = [];
      }
      if (method === "container.open") opened = true;
      if (method === "container.close") {
        if (kind === "repair_tool") { for (const stack of slots.filter(s => s.slot !== 2)) insert(stack); slots = []; }
        opened = false;
      }
      if (method === "container.state") return { open: opened, containerId: 1, type: kind === "craft" ? "minecraft:crafting" : station, size: kind === "craft" ? 10 : 3, slots } as T;
      if (method === "qc.anvil.state") {
        const source = slots.find(s => s.slot === 0);
        return { open: opened, cost: options.cost ?? 3, ...(!options.noResult && (options.cost ?? 3) < 40 && source && slots.some(s => s.slot === 1) ? { result: { id: output, damage: Math.max(0, (source.damage ?? 0) - 1170) } } : {}) } as T;
      }
      if (method === "recipes.query") return { recipes: [{ known: true, type: kind === "craft" ? "crafting" : "smelting", ref: "test-recipe", width: kind === "craft" ? 3 : 1, result: { id: output, count: 1 }, ingredients: Array.from({ length: kind === "craft" ? 5 : 1 }, () => [input]) }] } as T;
      if (method === "craft.place") {
        used = true;
        if (options.craftFails) throw new Error("craft refused");
        slots = [{ slot: 0, id: output, count: 1 }];
      }
      if (method === "container.click") {
        const size = kind === "craft" ? 10 : 3, slot = Number(params.slot);
        if (params.mode === "quick_move") {
          const stack = slots.find(s => s.slot === (kind === "repair_tool" ? 0 : slot)); assert.ok(stack);
          if (kind === "repair_tool") { insert({ ...stack, id: output, damage: Math.max(0, (stack.damage ?? 0) - 1170) }); slots = []; if (!options.keepXp) xp -= options.cost ?? 3; }
          else { insert(stack); slots = slots.filter(s => s.slot !== slot); }
          used = true;
          if (options.pickupFull) for (let i = 0; i < 36; i++) if (!stacks.some(s => s.slot === i)) stacks.push({ slot: i, id: "minecraft:dirt", count: 64 });
        } else {
          const playerSlot = slot >= size ? slot >= size + 27 ? slot - size - 27 : slot - size + 9 : null;
          const list = playerSlot === null ? slots : stacks, index = playerSlot ?? slot;
          const existing = list.find(s => s.slot === index);
          if (!cursor) {
            if (existing) { cursor = { ...existing }; list.splice(list.indexOf(existing), 1); }
          } else {
            const n = params.button === 1 ? 1 : cursor.count;
            if (existing) existing.count += n; else list.push({ ...cursor, slot: index, count: n });
            cursor.count -= n; if (!cursor.count) cursor = null;
          }
          if (kind === "smelt" && slots.some(s => s.slot === 0) && slots.some(s => s.slot === 1)) {
            used = true;
            // Retain unused fuel so portable-furnace cleanup must recover it before breaking.
            slots = [{ slot: 1, id: "minecraft:coal", count: 1 }, { slot: 2, id: output, count: 1 }];
          }
        }
      }
      return {} as T;
    } },
    config: { home: [0, 64, 0], selfGoal: { radius: 256 }, protect: { naturalBlocks: [], zones: [] } } as unknown as Config,
    notes: { get: () => notes, async update(fn) { fn(notes); } },
    events: { on: () => () => {}, next: async () => null },
    chat: { route: () => ({ kind: "ignore" }), say: async () => ({ ok: false, summary: "unused" }), reply: async () => ({ ok: false, summary: "unused" }) },
    signal: new AbortController().signal, log() {},
  };
  return { env, output, station, calls, notes, state: () => ({ placed, broken, used, opened, xp, stacks }) };
}

async function fastSkill(t: TestContext, run: (sleepFor: SkillSleep) => Promise<ToolResult>): Promise<ToolResult> {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  return run(async (ms, signal) => { signal.throwIfAborted(); t.mock.timers.tick(ms); });
}

test("repair_tool takes the most damaged enchanted tool and spends the quoted XP", async t => {
  const fake = inventorySkill("repair_tool", { xp: 3, cost: 3 });
  const answer = await fastSkill(t, sleepFor => executeSkill("repair_tool", { item: fake.output, x: 1, y: 64, z: 0 }, fake.env, Date.now, sleepFor));
  assert.equal(answer.ok, true);
  assert.equal(answer.summary, "Repaired minecraft:diamond_sword: 761 -> 1561 durability for 3 levels");
  const delta = answer.observedDelta as { before: { damage: number }; after: { damage: number }; cost: number; material: string; units: number };
  assert.equal(delta.before.damage, 800); assert.equal(delta.after.damage, 0);
  assert.equal(delta.cost, 3); assert.equal(delta.material, "minecraft:diamond"); assert.equal(delta.units, 3);
  assert.equal(fake.state().xp, 0); assert.equal(fake.state().opened, false);
  assert.equal(fake.notes.places[0]?.kind, "anvil");
});

test("repair_tool failures return inputs, close the menu, and never spend XP", async t => {
  for (const [options, summary] of [
    [{ noMaterial: true }, "no repair material (minecraft:diamond)"],
    [{ cost: 40 }, "too expensive"],
    [{ cost: 5, xp: 4 }, "need 5 XP levels, have 4"],
    [{ noResult: true }, "anvil shows no result"],
    [{ armor: true, noArmorSlot: true }, "no free slot to repair from armor"],
    [{ keepXp: true }, "repair unverified"],
  ] as Array<[FakeOptions, string]>) await t.test(summary, async child => {
    const fake = inventorySkill("repair_tool", options);
    const answer = await fastSkill(child, sleepFor => executeSkill("repair_tool", { item: fake.output, x: 1, y: 64, z: 0 }, fake.env, Date.now, sleepFor));
    assert.equal(answer.ok, false); assert.equal(answer.summary, summary);
    assert.equal(fake.state().opened, false); assert.equal(fake.state().xp, options.xp ?? 10);
    if (!("keepXp" in options)) assert.ok(fake.state().stacks.some(stack => stack.id === fake.output && stack.damage === 800) || options.armor);
  });
});

test("repair_tool moves worn armor to storage and reports that it is not re-equipped", async t => {
  const fake = inventorySkill("repair_tool", { armor: true });
  const answer = await fastSkill(t, sleepFor => executeSkill("repair_tool", { item: fake.output, x: 1, y: 64, z: 0 }, fake.env, Date.now, sleepFor));
  assert.equal(answer.ok, true); assert.match(answer.summary, /call equip/);
  assert.ok(fake.calls.some(call => call.method === "inventory.swapSlots" && call.params.slotA === 38));
});

test("portable stations are placed, used, emptied, and picked up without stale notes", async t => {
  for (const kind of ["craft", "smelt"] as const) await t.test(kind, async child => {
    const fake = inventorySkill(kind);
    const answer = await fastSkill(child, sleepFor => executeSkill(kind, { item: fake.output, count: 1 }, fake.env, Date.now, sleepFor));
    assert.equal(answer.ok, true); assert.doesNotMatch(answer.summary, /station left/);
    assert.deepEqual({ placed: fake.state().placed, broken: fake.state().broken, used: fake.state().used }, { placed: false, broken: true, used: true });
    assert.equal(itemCount({ hotbar: fake.state().stacks, main: [] }, fake.station), 1);
    assert.equal(fake.notes.places.length, 0);
    assert.equal(fake.state().opened, false);
    if (kind === "smelt") assert.equal(itemCount({ hotbar: fake.state().stacks, main: [] }, "minecraft:coal"), 2);
  });
});

test("station pickup does not break a block with no inventory capacity", async t => {
  const fake = inventorySkill("craft", { pickupFull: true });
  const answer = await fastSkill(t, sleepFor => executeSkill("craft", { item: fake.output, count: 1 }, fake.env, Date.now, sleepFor));
  assert.equal(answer.ok, true); assert.match(answer.summary, /; station left placed at 1 64 0$/);
  assert.equal(fake.state().placed, true); assert.equal(fake.state().broken, false);
  assert.equal(fake.notes.places[0]?.kind, "owned");
});

test("a failed craft still picks up its newly placed table", async t => {
  const fake = inventorySkill("craft", { craftFails: true });
  const answer = await fastSkill(t, sleepFor => executeSkill("craft", { item: fake.output, count: 1 }, fake.env, Date.now, sleepFor));
  assert.equal(answer.ok, false); assert.equal(answer.summary, "craft refused");
  assert.equal(fake.state().broken, true); assert.equal(fake.notes.places.length, 0);
});

test("an uncollected station drop is reported without claiming the block is still placed", async t => {
  const fake = inventorySkill("craft", { noPickup: true });
  const answer = await fastSkill(t, sleepFor => executeSkill("craft", { item: fake.output, count: 1 }, fake.env, Date.now, sleepFor));
  assert.equal(answer.ok, true);
  assert.match(answer.summary, /; station dropped at 1 64 0, not collected$/);
  assert.equal(fake.state().placed, false); assert.equal(fake.state().broken, true);
  assert.equal(fake.notes.places.length, 0);
});

test("station approach accepts Baritone foot-block arrival despite a larger exact-coordinate distance", async t => {
  const fake = inventorySkill("repair_tool", { footArrival: true });
  const answer = await fastSkill(t, sleepFor => executeSkill("repair_tool", { item: fake.output, x: 1, y: 64, z: 0 }, fake.env, Date.now, sleepFor));
  assert.equal(answer.ok, true, answer.summary);
  assert.ok(fake.calls.some(call => call.method === "qc.baritone.goto"));
  assert.ok(4.9 - 1 > 3);
  assert.equal(goalSatisfied([4.9, 64, 0], { x: 1, y: 64, z: 0, range: 3 }), true);
});
