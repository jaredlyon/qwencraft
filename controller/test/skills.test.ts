import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolsForLlm, validateArguments } from "../tools.ts";
import { blocksForItem, chooseRecipe, dropForBlock, goalSatisfied, inventoryDelta, isProtected, itemCount, itemId } from "../skills.ts";
import type { Config, Notes, SkillEnv } from "../types.ts";

const expected = "observe look_screenshot go_to go_to_player follow_player explore collect mine craft smelt place_block break_block equip eat attack chest_deposit chest_withdraw drop chat_say chat_reply run_command remember recall set_goal finish_goal wait stop harness_info".split(" ");

test("curated registry and OpenAI schema contain exactly the operator-approved tools", () => {
  assert.deepEqual(TOOLS.map(t => t.name), expected);
  assert.equal(new Set(TOOLS.map(t => t.name)).size, 28);
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
  assert.equal(isProtected(c, notes, "minecraft:stone", [4, 4, 4]), true);
  assert.equal(isProtected(c, notes, "minecraft:stone", [10, 10, 10]), true);
  assert.equal(isProtected(c, notes, "minecraft:crafting_table", [100, 0, 0]), true);
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
    chat: { route: unused, say: unused, reply: unused, announceStart: unused, announceTakeover: unused },
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
