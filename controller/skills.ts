import { setTimeout as delay } from "node:timers/promises";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { redact, searchHarness } from "./selfinfo.ts";
import type { Bridge, Config, Notes, SkillEnv, ToolResult, Vec3 } from "./types.ts";
import { REFLEX_OWNS_BODY } from "./types.ts";
import { withinHome, horizontalDistance, observe, tickSnapshot } from "./observe.ts";

type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid bridge response");
  return value as ObjectValue;
}
function list(value: unknown): ObjectValue[] { return Array.isArray(value) ? value.map(object) : []; }
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("unavailable numeric observation");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("unavailable string observation");
  return value;
}
export function itemId(value: string): string {
  const id = value.includes(":") ? value : `minecraft:${value}`;
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) throw new Error("invalid item/block id");
  return id;
}
function pos(value: ObjectValue): Vec3 { return [number(value.x), number(value.y), number(value.z)]; }
function coordinates(p: Vec3): ObjectValue { return { x: p[0], y: p[1], z: p[2] }; }
function distance(a: Vec3, b: Vec3): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export function inventoryStacks(value: unknown): ObjectValue[] {
  const inv = object(value);
  return [...list(inv.hotbar), ...list(inv.main)];
}
export function itemCount(value: unknown, id: string): number {
  const inv = object(value);
  const stacks = [...inventoryStacks(inv), ...list(inv.armor)];
  if (inv.offhand && typeof inv.offhand === "object") stacks.push(object(inv.offhand));
  return stacks.filter(s => s.id === id).reduce((n, s) => n + number(s.count), 0);
}
export function inventoryDelta(before: unknown, after: unknown, id: string): number { return itemCount(after, id) - itemCount(before, id); }
export function isProtected(c: Config, notes: Readonly<Notes>, id: string, p: Vec3): boolean {
  return !c.protect.naturalBlocks.includes(id) && ![...c.protect.zones, ...notes.zones].some(z => p.every((v, i) => v >= z.min[i]! && v <= z.max[i]!));
}
export function goalSatisfied(p: Vec3, args: ObjectValue): boolean {
  const x = Math.floor(number(args.x)), z = Math.floor(number(args.z));
  if (args.y === undefined) return Math.floor(p[0]) === x && Math.floor(p[2]) === z;
  const y = Math.floor(number(args.y));
  if (args.range !== undefined) return distance(p.map(Math.floor) as Vec3, [x, y, z]) <= number(args.range);
  return Math.floor(p[0]) === x && Math.floor(p[1]) === y && Math.floor(p[2]) === z;
}

// Verified against 26.3 VanillaBlockLoot. Unsupported/conditional drops fail closed;
// Silk Touch cannot falsely succeed because the actual requested item delta is required.
const drops: Record<string, string> = {
  stone: "cobblestone", deepslate: "cobbled_deepslate", grass_block: "dirt", podzol: "dirt", mycelium: "dirt",
  coal_ore: "coal", deepslate_coal_ore: "coal", iron_ore: "raw_iron", deepslate_iron_ore: "raw_iron",
  gold_ore: "raw_gold", deepslate_gold_ore: "raw_gold", diamond_ore: "diamond", deepslate_diamond_ore: "diamond",
  emerald_ore: "emerald", deepslate_emerald_ore: "emerald", nether_quartz_ore: "quartz",
};
const selfDrops = new Set(["granite", "diorite", "andesite", "dirt", "coarse_dirt", "cobblestone", "sand", "red_sand", "bamboo_block", "mud", "mangrove_roots"]);
for (const tree of ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "pale_oak", "poplar", "cherry", "mangrove"]) {
  selfDrops.add(`${tree}_log`); selfDrops.add(`${tree}_wood`);
  selfDrops.add(`stripped_${tree}_log`); selfDrops.add(`stripped_${tree}_wood`);
}
export function dropForBlock(block: string): string | null {
  const id = itemId(block);
  if (!id.startsWith("minecraft:")) return null;
  const short = id.slice(10), drop = drops[short];
  return drop ? itemId(drop) : selfDrops.has(short) ? id : null;
}
export function blocksForItem(item: string): string[] {
  const id = itemId(item);
  return [...selfDrops, ...Object.keys(drops)].map(itemId).filter(block => dropForBlock(block) === id);
}
export function chooseRecipe(value: unknown, item: string, type: string): ObjectValue | null {
  const recipes = list(object(value).recipes).filter(r => r.known === true && r.type === type && object(r.result).id === item && number(object(r.result).count) > 0);
  return recipes.sort((a, b) => listIngredients(a).length - listIngredients(b).length || string(a.ref).localeCompare(string(b.ref)))[0] ?? null;
}
function listIngredients(recipe: ObjectValue): string[][] {
  if (!Array.isArray(recipe.ingredients)) throw new Error("recipe ingredients unavailable");
  return recipe.ingredients.map(v => {
    if (!Array.isArray(v) || !v.length) throw new Error("recipe ingredients unavailable");
    return v.map(string);
  });
}
const foodItems: Record<string, true> = Object.fromEntries("apple baked_potato beef beetroot beetroot_soup bread carrot chicken chorus_fruit cod cooked_beef cooked_chicken cooked_cod cooked_mutton cooked_porkchop cooked_rabbit cooked_salmon cookie dried_kelp enchanted_golden_apple golden_apple golden_carrot honey_bottle melon_slice mushroom_stew mutton poisonous_potato porkchop potato pufferfish pumpkin_pie rabbit rabbit_stew rotten_flesh salmon spider_eye suspicious_stew sweet_berries glow_berries tropical_fish".split(" ").map(id => [itemId(id), true]));
const safeFoods: Record<string, true> = Object.fromEntries("bread cooked_beef cooked_chicken cooked_cod cooked_mutton cooked_porkchop cooked_rabbit cooked_salmon baked_potato carrot apple beetroot pumpkin_pie melon_slice cookie dried_kelp sweet_berries glow_berries mushroom_stew rabbit_stew beetroot_soup golden_carrot".split(" ").map(id => [itemId(id), true]));
const outcomes = new WeakMap<Bridge, ToolResult[]>();
/** Consecutive Baritone path-calculation failures (~2 s apart) after which a job is declared unreachable. */
export const MAX_PATH_FAILURES = 5;
const cleanupMethods = ["qc.baritone.stop", "interact.stopBreaking", "control.stopUsing", "nav.stop", "control.stop"];
export async function stopMotion(env: SkillEnv): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(cleanupMethods.map(async method => {
    try { await env.bridge.rpc(method, {}, { timeoutMs: 3000 }); }
    catch { failed.push(method); }
  }));
  return failed;
}

class Skill {
  env: SkillEnv;
  deadline: number;
  menuId: number | null = null;
  cursorOrigin: number | null = null;
  cursorUnknown = false;
  observed: ObjectValue = {};
  constructor(env: SkillEnv, budget = 120000) { this.env = env; this.deadline = Date.now() + budget; }
  check(): void {
    if (this.env.signal.aborted) throw new Error("interrupted");
    if (Date.now() > this.deadline) throw new Error("skill timed out");
  }
  async rpc(method: string, params: ObjectValue = {}): Promise<ObjectValue> {
    this.check();
    const value = object(await this.env.bridge.rpc(method, params, { signal: this.env.signal, timeoutMs: Math.max(1, Math.min(10000, this.deadline - Date.now())) }));
    this.check();
    return value;
  }
  async sleep(ms = 250): Promise<void> { this.check(); await delay(Math.min(ms, Math.max(1, this.deadline - Date.now())), undefined, { signal: this.env.signal }); this.check(); }
  async inventory(): Promise<ObjectValue> { return this.rpc("player.getInventory"); }
  async player(): Promise<ObjectValue> { return this.rpc("player.getState"); }
  homeTarget(p: Vec3): void { if (!withinHome(this.env.config, this.env.notes.get() as Notes, p)) throw new Error("home radius exceeded"); }
  async homePosition(): Promise<ObjectValue> {
    const player = await this.player(), p = pos(player), home = this.env.notes.get().home ?? this.env.config.home;
    if (home && horizontalDistance(home, p) > this.env.config.selfGoal.radius + 16) throw new Error("home radius exceeded");
    this.observed.position = p;
    return player;
  }
  async block(p: Vec3, tool = false): Promise<ObjectValue> {
    const rows = list((await this.rpc("perception.blocks", { positions: [coordinates(p)], tool })).blocks);
    const block = rows[0];
    if (!block || block.loaded !== true) throw new Error("target block not loaded");
    return block;
  }
  async job(method: string, params: ObjectValue, success: () => Promise<boolean>, timeout = 120000): Promise<boolean> {
    let early: ObjectValue | null = null;
    // Consecutive calc_failed events per task, reset by at_goal. Baritone's mine process retries forever by
    // blacklisting one unreachable ore at a time, so a stuck mine must be ended here instead of at the timeout.
    const failures = new Map<string, number>();
    const remove = this.env.events.on("qc.task", event => {
      try {
        early = object(event.data);
        const id = string(early.taskId);
        if (early.state === "calc_failed") failures.set(id, (failures.get(id) ?? 0) + 1);
        else if (early.state === "at_goal") failures.delete(id);
      } catch { /* Ignore unrelated malformed event. */ }
    });
    let taskId = "";
    try {
      const started = await this.rpc(method, params);
      if (started.started !== true) throw new Error("task did not start");
      taskId = string(started.taskId);
      this.observed.taskId = taskId;
      const end = Math.min(this.deadline, Date.now() + timeout);
      const initialDimension = string((await this.player()).dimension);
      while (Date.now() < end) {
        this.check();
        const player = await this.homePosition();
        if (player.dimension !== initialDimension) throw new Error("movement interrupted: dimension changed");
        if (await success()) return true;
        if ((failures.get(taskId) ?? 0) >= MAX_PATH_FAILURES) {
          throw new Error(`no reachable target: path calculation failed ${MAX_PATH_FAILURES} times in a row (protected blocks or terrain in the way); try somewhere else`);
        }
        const status = await this.rpc("qc.baritone.status");
        const signal = early as ObjectValue | null;
        if (signal?.taskId === taskId) { this.observed.taskEvent = signal; early = null; }
        if (status.taskId !== taskId || status.active !== true) {
          if (await success()) return true;
          throw new Error(signal?.state === "calc_failed" || status.lastPathEvent === "calc_failed" ? "path calculation failed" : "movement interrupted");
        }
        const event = await this.env.events.next("qc.task", e => {
          try { return object(e.data).taskId === taskId; } catch { return false; }
        }, Math.min(500, end - Date.now()), this.env.signal);
        if (event) early = object(event.data);
      }
      return false;
    } finally {
      remove();
      const stopped = object(await this.env.bridge.rpc("qc.baritone.stop", {}, { timeoutMs: 3000 }));
      const status = object(await this.env.bridge.rpc("qc.baritone.status", {}, { timeoutMs: 3000 }));
      this.observed.taskAfterStop = status;
      if (stopped.stopped !== true || status.active !== false) throw new Error("stop unverified");
    }
  }
  async go(p: Vec3, range = 3): Promise<void> {
    this.homeTarget(p);
    if (distance(pos(await this.player()), p) <= range) return;
    if (!await this.job("qc.baritone.goto", { ...coordinates(p), range }, async () => distance(pos(await this.player()), p) <= range, 60000)) throw new Error("out of reach");
  }
  async hold(id: string): Promise<void> {
    const inventory = await this.inventory();
    const stack = inventoryStacks(inventory).find(s => s.id === id);
    if (!stack) throw new Error("item missing");
    const slot = number(stack.slot);
    const selected = number(inventory.selectedSlot);
    if (slot > 8) await this.rpc("inventory.swapSlots", { slotA: slot, slotB: selected });
    else await this.rpc("inventory.selectHotbar", { slot });
    await this.sleep(150);
    if (object((await this.rpc("player.getEquipment")).mainHand).id !== id) throw new Error("equip unverified");
  }
  async open(p: Vec3, expected: string[]): Promise<ObjectValue> {
    await this.go(p);
    await this.rpc("control.setInput", { sneak: false });
    await this.rpc("container.open", coordinates(p));
    const end = Math.min(this.deadline, Date.now() + 5000);
    while (Date.now() < end) {
      const state = await this.rpc("container.state");
      if (state.open === true && expected.includes(string(state.type))) {
        this.menuId = number(state.containerId);
        return state;
      }
      await this.sleep();
    }
    throw new Error("container inaccessible");
  }
  async menu(): Promise<ObjectValue> {
    const state = await this.rpc("container.state");
    if (this.menuId !== null && (state.open !== true || state.containerId !== this.menuId)) throw new Error("container changed");
    return state;
  }
  async click(slot: number, button = 0, mode = "pickup"): Promise<void> {
    await this.menu();
    try { await this.rpc("container.click", { slot, button, mode }); }
    catch (error) { this.cursorUnknown = mode === "pickup"; throw error; }
    await this.sleep(150);
  }
  async close(): Promise<void> {
    if (this.menuId === null && this.cursorOrigin === null) return;
    if (this.cursorOrigin !== null && !this.cursorUnknown) {
      try {
        const state = object(await this.env.bridge.rpc("container.state", {}, { timeoutMs: 3000 }));
        if (state.containerId !== this.menuId) throw new Error("container changed during cursor recovery");
        await this.env.bridge.rpc("container.click", { slot: this.cursorOrigin, button: 0, mode: "pickup" }, { timeoutMs: 3000 });
        this.cursorOrigin = null;
      } catch { this.cursorUnknown = true; }
    }
    if (this.cursorUnknown) {
      this.env.log("Cursor outcome unknown: leaving menu open for operator recovery; no automatic click retry.");
      this.observed.cursorRecoveryRequired = true;
      return;
    }
    await this.env.bridge.rpc("container.close", {}, { timeoutMs: 3000 });
    this.menuId = null;
  }
  // Counted pickup/right-click/return avoids container.transfer's whole-stack overshoot.
  async moveCount(source: number, destination: number, count: number): Promise<void> {
    this.cursorOrigin = source;
    await this.click(source);
    for (let i = 0; i < count; i++) await this.click(destination, 1);
    await this.click(source);
    this.cursorOrigin = null;
  }
  playerMenuSlot(slot: number, size: number): number { return slot < 9 ? size + 27 + slot : size + slot - 9; }
  async transfer(id: string, count: number, take: boolean, destinationSlot?: number): Promise<void> {
    let left = count;
    while (left > 0) {
      this.check();
      const menu = await this.menu(), size = number(menu.size), inv = await this.inventory();
      const source = (take ? list(menu.slots) : inventoryStacks(inv)).find(s => s.id === id && (destinationSlot === undefined || !take || s.slot === destinationSlot));
      if (!source) throw new Error("insufficient items");
      const sourceSlot = take ? number(source.slot) : this.playerMenuSlot(number(source.slot), size);
      let target: number;
      if (destinationSlot !== undefined && !take) target = destinationSlot;
      else {
        const occupied = take ? inventoryStacks(inv) : list(menu.slots);
        // Empty slots only: unknown item max-stack sizes cannot cause a partial merge.
        const slots = take ? Array.from({ length: 36 }, (_, i) => i) : Array.from({ length: size }, (_, i) => i);
        const empty = slots.find(i => !occupied.some(s => s.slot === i));
        if (empty === undefined) throw new Error(take ? "inventory full" : "chest full");
        target = take ? this.playerMenuSlot(empty, size) : empty;
      }
      const n = Math.min(left, number(source.count));
      const beforePlayer = itemCount(inv, id), beforeContainer = menuCount(menu, id);
      await this.moveCount(sourceSlot, target, n);
      const expectedPlayer = beforePlayer + (take ? n : -n);
      const end = Math.min(this.deadline, Date.now() + 3000);
      let acknowledged = false;
      while (Date.now() < end) {
        const afterInv = await this.inventory(), afterMenu = await this.menu();
        const afterPlayer = itemCount(afterInv, id), afterContainer = menuCount(afterMenu, id);
        // A live furnace may consume newly inserted input/fuel, so acknowledge source
        // decrease and let its production postcondition verify the destination later.
        if (afterPlayer === expectedPlayer && (destinationSlot !== undefined || afterContainer === beforeContainer + (take ? -n : n))) { acknowledged = true; break; }
        await this.sleep();
      }
      if (!acknowledged) throw new Error("transfer unverified");
      left -= n;
    }
  }
  async station(id: string): Promise<Vec3> {
    const scan = await this.rpc("perception.scan", { radius: 2, find: [id], findLimit: 32 });
    const session = await this.rpc("session.info");
    const candidates = list(scan.found);
    const notes = this.env.notes.get();
    const known = candidates.find(candidate => notes.places.some(place => place.pos && place.dimension === session.dimension && place.note.includes(string(session.worldId)) && distance(place.pos, pos(candidate)) < 0.1 && (place.kind === "owned" || place.kind === "station" || place.kind === "authorized")));
    if (known) return pos(known);
    const inv = await this.inventory();
    if (itemCount(inv, id) === 0) await craft(this, id, 1, []);
    if (itemCount(await this.inventory(), id) === 0) throw new Error("station inaccessible: no authorized or owned station");
    const p = pos(await this.player()).map(Math.floor) as Vec3;
    for (const offset of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const at: Vec3 = [p[0] + offset[0]!, p[1], p[2] + offset[1]!];
      if ((await this.block(at)).air !== true || (await this.block([at[0], at[1] - 1, at[2]])).air === true) continue;
      await place(this, id, at, "up");
      await this.env.notes.update(n => n.places.push({ kind: "owned", name: id, note: `Placed by controller on ${String(session.worldId)}`, pos: at, dimension: string(session.dimension), at: Date.now() }));
      return at;
    }
    throw new Error("station inaccessible: no safe placement");
  }
}
function menuCount(menu: ObjectValue, id: string): number { return list(menu.slots).filter(s => s.id === id).reduce((n, s) => n + number(s.count), 0); }
function result(ok: boolean, summary: string, observedDelta: unknown = {}): ToolResult { return { ok, summary, observedDelta }; }

async function acquisition(s: Skill, blocks: string[], id: string, count: number): Promise<ToolResult> {
  if (!blocks.length) throw new Error("drop mapping unsupported");
  if (blocks.some(b => !s.env.config.protect.naturalBlocks.includes(b))) throw new Error("protected block");
  const scan = await s.rpc("perception.scan", { radius: 3, find: blocks, findLimit: 64 });
  const candidates = list(scan.found).filter(b => !isProtected(s.env.config, s.env.notes.get(), string(b.id), pos(b)));
  if (!candidates.length) throw new Error("resource not found");
  s.homeTarget(pos(candidates[0]!));
  const probe = await s.block(pos(candidates[0]!), true);
  if (probe.canHarvest !== true) throw new Error("cannot harvest");
  await s.rpc("inventory.selectHotbar", { slot: number(probe.bestSlot) });
  const before = await s.inventory(), start = itemCount(before, id), targetCount = start + count;
  if (!Number.isSafeInteger(targetCount)) throw new Error("invalid final inventory count");
  let after = before;
  const ok = await s.job("qc.baritone.mine", { blocks, targetCount }, async () => {
    after = await s.inventory();
    s.observed.acquisition = { item: id, before: start, after: itemCount(after, id), acquired: inventoryDelta(before, after, id), targetCount };
    return inventoryDelta(before, after, id) >= count;
  });
  return result(ok, ok ? `Acquired ${inventoryDelta(before, after, id)} ${id}` : "mining failed", s.observed);
}
async function place(s: Skill, id: string, p: Vec3, face: string): Promise<ToolResult> {
  const before = await s.inventory();
  if ((await s.block(p)).air !== true) throw new Error("placement unverified: target is occupied");
  const offsets: Record<string, Vec3> = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
  const d = offsets[face]!;
  const support: Vec3 = [p[0] - d[0], p[1] - d[1], p[2] - d[2]];
  if ((await s.block(support)).air === true) throw new Error("placement unverified: support is air");
  await s.go(p);
  await s.hold(id);
  await s.rpc("control.lookAt", { x: support[0] + .5 + d[0] * .5, y: support[1] + .5 + d[1] * .5, z: support[2] + .5 + d[2] * .5 });
  await s.rpc("control.setInput", { sneak: true });
  try { await s.rpc("interact.placeBlock", { ...coordinates(support), face }); }
  finally { await s.env.bridge.rpc("control.setInput", { sneak: false }, { timeoutMs: 3000 }); }
  const end = Math.min(s.deadline, Date.now() + 5000);
  while (Date.now() < end) {
    const block = await s.block(p), after = await s.inventory();
    const used = -inventoryDelta(before, after, id);
    if (block.id === id && used >= 1) return result(true, `Placed ${id}`, { position: p, block, used });
    await s.sleep();
  }
  throw new Error("placement unverified");
}
async function craft(s: Skill, id: string, count: number, chain: string[]): Promise<ToolResult> {
  if (chain.includes(id) || chain.length > 12) throw new Error("recipe cycle or depth exceeded");
  const recipe = chooseRecipe(await s.rpc("recipes.query", { items: [id], includeUnknown: false }), id, "crafting");
  if (!recipe) throw new Error("recipe not unlocked");
  const before = await s.inventory(), batch = number(object(recipe.result).count), batches = Math.ceil(count / batch);
  const inventory = await s.inventory();
  const needed = new Map<string, number>();
  for (const alternatives of listIngredients(recipe)) {
    const chosen = alternatives.find(item => itemCount(inventory, item) > (needed.get(item) ?? 0)) ?? alternatives[0]!;
    needed.set(chosen, (needed.get(chosen) ?? 0) + batches);
  }
  for (const [ingredient, amount] of needed) {
    const missing = amount - itemCount(await s.inventory(), ingredient);
    if (missing > 0) await craft(s, ingredient, missing, [...chain, id]);
  }
  const needsTable = number(recipe.width ?? 0) > 2 || number(recipe.height ?? 0) > 2 || listIngredients(recipe).length > 4;
  if (needsTable) await s.open(await s.station("minecraft:crafting_table"), ["minecraft:crafting"]);
  else {
    const menu = await s.rpc("container.state");
    if (menu.open === true) throw new Error("craft output unverified: another container is open");
  }
  try {
    for (let i = 0; i < batches; i++) {
      const start = itemCount(await s.inventory(), id);
      await s.rpc("craft.place", { ref: string(recipe.ref), all: false });
      const end = Math.min(s.deadline, Date.now() + 5000);
      let ready = false;
      while (Date.now() < end) {
        const output = list((await s.menu()).slots).find(slot => slot.slot === 0 && slot.id === id);
        if (output && number(output.count) === batch) { ready = true; break; }
        await s.sleep();
      }
      if (!ready) throw new Error("ingredients missing");
      await s.click(0, 0, "quick_move");
      const endAck = Math.min(s.deadline, Date.now() + 3000);
      let gained = false;
      while (Date.now() < endAck) {
        if (itemCount(await s.inventory(), id) >= start + batch) { gained = true; break; }
        await s.sleep();
      }
      if (!gained) throw new Error("craft output unverified");
    }
    const delta = inventoryDelta(before, await s.inventory(), id);
    return result(delta >= count, delta >= count ? `Crafted ${delta} ${id}; batch surplus ${delta - count}` : "craft output unverified", { item: id, acquired: delta, requested: count, surplus: delta - count, recipe: recipe.ref });
  } finally { await s.close(); }
}

async function smelt(s: Skill, id: string, count: number, fuelArg?: string): Promise<ToolResult> {
  const recipe = chooseRecipe(await s.rpc("recipes.query", { items: [id], includeUnknown: false }), id, "smelting");
  if (!recipe) throw new Error("recipe not unlocked");
  const before = await s.inventory(), outputPerInput = number(object(recipe.result).count);
  const units = Math.ceil(count / outputPerInput);
  const input = listIngredients(recipe)[0]?.find(item => itemCount(before, item) >= units);
  if (!input) throw new Error("ingredients missing");
  // Verified in 26.3 Items + cooking/time_coal: coal/charcoal burn 1600 ticks.
  const fuelCount = Math.ceil(units / 8);
  const fuel = fuelArg ? itemId(fuelArg) : ["minecraft:coal", "minecraft:charcoal"].find(item => itemCount(before, item) >= fuelCount);
  if (!fuel || !["minecraft:coal", "minecraft:charcoal"].includes(fuel)) throw new Error("fuel missing: supported fuel is coal or charcoal");
  if (itemCount(before, fuel) < fuelCount) throw new Error("fuel missing");
  const menu = await s.open(await s.station("minecraft:furnace"), ["minecraft:furnace"]);
  try {
    if (list(menu.slots).length) throw new Error("furnace inaccessible: occupied slots would confound new output");
    let remaining = units, taken = 0, insertedInput = 0, insertedFuel = 0;
    while (remaining > 0) {
      // Respect the input stack's observed size instead of guessing modded max-stack size.
      const stack = inventoryStacks(await s.inventory()).find(value => value.id === input);
      if (!stack) throw new Error("ingredients missing");
      const batchInputs = Math.min(remaining, number(stack.count));
      const batchFuel = Math.ceil(batchInputs / 8);
      await s.transfer(input, batchInputs, false, 0);
      await s.transfer(fuel, batchFuel, false, 1);
      insertedInput += batchInputs;
      insertedFuel += batchFuel;
      const end = Math.min(s.deadline, Date.now() + batchInputs * 12000 + 10000);
      let batchTaken = 0, lastProgress = Date.now();
      while (batchTaken < batchInputs * outputPerInput && Date.now() < end) {
        const state = await s.menu();
        s.observed.furnace = { input, fuel, insertedInput, insertedFuel, slots: state.slots, taken };
        const output = list(state.slots).find(slot => slot.slot === 2 && slot.id === id);
        if (output) {
          const n = Math.min(batchInputs * outputPerInput - batchTaken, number(output.count));
          await s.transfer(id, n, true, 2);
          batchTaken += n;
          taken += n;
          lastProgress = Date.now();
        }
        if (Date.now() - lastProgress > 30000) throw new Error("smelting timed out: no progress");
        if (batchTaken < batchInputs * outputPerInput) await s.sleep(500);
      }
      if (batchTaken < batchInputs * outputPerInput) throw new Error("smelting timed out");
      remaining -= batchInputs;
    }
    const delta = inventoryDelta(before, await s.inventory(), id);
    return result(delta >= count, delta >= count ? `Smelted ${delta} ${id}` : "smelting output unverified", { ...s.observed, item: id, acquired: delta, requested: count, surplus: delta - count });
  } finally { await s.close(); }
}

async function namedPlayer(s: Skill, name: string): Promise<ObjectValue> {
  const scene = await s.rpc("vision.describeScene", { maxDistance: 64 });
  const named = list(scene.entities).filter(e => e.name === name && e.type === "minecraft:player");
  if (named.length > 1) throw new Error("player ambiguous");
  if (!named.length) throw new Error("player not visible");
  const uuid = string(named[0]!.uuid);
  const players = list((await s.rpc("perception.entities", { radius: 64, kinds: ["player"] })).entities);
  const matched = players.find(e => e.uuid === uuid);
  if (!matched) throw new Error("player not visible");
  s.observed.playerIdentity = { name, uuid };
  return matched;
}
async function follow(s: Skill, name: string, bounded: boolean): Promise<ToolResult> {
  const target = await namedPlayer(s, name), uuid = string(target.uuid);
  s.homeTarget(pos(target));
  const before = pos(await s.player()), initialDistance = distance(before, pos(target));
  let observations = 0, near = false, finalDistance = initialDistance;
  const ok = await s.job("qc.baritone.follow", { player: name }, async () => {
    const current = list((await s.rpc("perception.entities", { radius: 64, kinds: ["player"] })).entities).find(e => e.uuid === uuid);
    if (!current) throw new Error("follow target lost");
    s.homeTarget(pos(current));
    const p = pos(await s.player());
    finalDistance = distance(p, pos(current));
    near = finalDistance <= 3;
    observations++;
    s.observed.tracking = { uuid, observations, target: pos(current), position: p, near };
    return !bounded && near;
  }, bounded ? 30000 : 60000);
  const moved = distance(before, pos(await s.player()));
  const verified = bounded ? observations >= 2 && (near || (moved > .5 && finalDistance < initialDistance)) : ok && near;
  return result(verified, verified ? bounded ? "Bounded follow stopped; observed tracking only" : `Reached ${name} within three blocks and stopped` : bounded ? "follow target lost: tracking unverified" : "target moved", { ...s.observed, moved, initialDistance, finalDistance });
}

async function dispatch(name: string, args: ObjectValue, s: Skill): Promise<ToolResult> {
  const env = s.env;
  switch (name) {
    case "observe": {
      const observation = await observe(env, { goal: null, lastResult: null, recentChat: [], hints: [] });
      s.check();
      const player = observation.player;
      return result(player !== null && player !== undefined, player ? "Fresh observation" : "observation unavailable", observation);
    }
    case "look_screenshot": {
      const image = await s.rpc("vision.screenshot");
      const encoded = string(image.base64), bytes = Buffer.from(encoded, "base64");
      const width = number(image.width), height = number(image.height);
      const valid = image.format === "png" && bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height && width > 0 && height > 0;
      return result(valid, valid ? "Captured client screenshot" : "screenshot unavailable", valid ? { image: `data:image/png;base64,${encoded}`, width, height } : {});
    }
    case "go_to": {
      const p: Vec3 = [number(args.x), args.y === undefined ? number((await s.player()).y) : number(args.y), number(args.z)];
      s.homeTarget(p);
      const ok = await s.job("qc.baritone.goto", args, async () => goalSatisfied(pos(await s.player()), args), 60000);
      return result(ok, ok ? "Requested goal position observed" : "movement interrupted", s.observed);
    }
    case "go_to_player": return follow(s, string(args.name), false);
    case "follow_player": return follow(s, string(args.name), true);
    case "explore": {
      const p = pos(await s.player()), initial = await s.rpc("perception.scan", { radius: 2 });
      s.homeTarget([number(args.x), p[1], number(args.z)]);
      await s.job("qc.baritone.explore", args, async () => false, 30000);
      const after = pos(await s.player()), scan = await s.rpc("perception.scan", { radius: 2 });
      const old = new Set(list(initial.chunks).map(c => `${String(c.cx)},${String(c.cz)}`));
      const fresh = list(scan.chunks).filter(c => !old.has(`${String(c.cx)},${String(c.cz)}`)).length;
      const moved = distance(p, after), ok = moved > .5 || fresh > 0;
      return result(ok, ok ? "Observed exploration progress; exploration stopped" : "no exploration progress", { position: after, moved, newChunks: fresh });
    }
    case "collect": return acquisition(s, blocksForItem(string(args.item)).filter(block => env.config.protect.naturalBlocks.includes(block)), itemId(string(args.item)), number(args.count));
    case "mine": {
      const block = itemId(string(args.block)), drop = dropForBlock(block);
      if (!drop) throw new Error("drop mapping unsupported");
      return acquisition(s, [block], drop, number(args.count));
    }
    case "craft": return craft(s, itemId(string(args.item)), number(args.count), []);
    case "smelt": return smelt(s, itemId(string(args.item)), number(args.count), args.fuel === undefined ? undefined : string(args.fuel));
    case "place_block": return place(s, itemId(string(args.item)), pos(args), args.face === undefined ? "up" : string(args.face));
    case "break_block": {
      const p = pos(args), before = await s.block(p, true), id = string(before.id);
      if (isProtected(env.config, env.notes.get(), id, p)) {
        const placed = await s.rpc("qc.placed.near", { ...coordinates(p), radius: 0 }).catch(() => ({ blocks: [] }));
        if (!list(placed.blocks).some(b => b.x === p[0] && b.y === p[1] && b.z === p[2] && b.id === id)) throw new Error("protected block");
      }
      if (before.canHarvest !== true || number(before.hardness) < 0) throw new Error("cannot harvest");
      await s.go(p);
      await s.rpc("inventory.selectHotbar", { slot: number(before.bestSlot) });
      await s.rpc("interact.breakBlock", { ...coordinates(p), mode: "survival" });
      try {
        const end = Math.min(s.deadline, Date.now() + 30000);
        while (Date.now() < end) {
          const after = await s.block(p);
          if (after.air === true && after.id !== id) return result(true, `Removed ${id}`, { position: p, before: id, after: after.id });
          await s.sleep();
        }
        throw new Error("break unverified");
      } finally { await env.bridge.rpc("interact.stopBreaking", {}, { timeoutMs: 3000 }); }
    }
    case "equip": {
      const id = itemId(string(args.item)), slot = args.slot === undefined ? "mainHand" : string(args.slot);
      if (slot === "mainHand") await s.hold(id);
      else {
        const destinations: Record<string, number> = { offHand: 40, helmet: 36, chest: 37, legs: 38, boots: 39 };
        const destination = destinations[slot];
        if (destination === undefined) throw new Error("slot unsupported");
        const stack = inventoryStacks(await s.inventory()).find(v => v.id === id);
        if (!stack) throw new Error("item missing");
        await s.rpc("inventory.swapSlots", { slotA: number(stack.slot), slotB: destination });
        await s.sleep(250);
      }
      const equipment = await s.rpc("player.getEquipment"), ok = object(equipment[slot]).id === id;
      return result(ok, ok ? `Equipped ${id} in ${slot}` : "equip unverified", { slot, equipment });
    }
    case "eat": {
      const before = await s.inventory(), player = await s.player();
      const id = args.item === undefined ? inventoryStacks(before).find(v => safeFoods[string(v.id)] === true)?.id : itemId(string(args.item));
      if (typeof id !== "string" || foodItems[id] !== true) throw new Error("no edible item");
      await s.hold(id);
      await s.rpc("control.look", { pitch: -90 });
      await s.rpc("control.startUsing");
      try {
        const end = Math.min(s.deadline, Date.now() + 10000);
        while (Date.now() < end) {
          const after = await s.inventory(), now = await s.player(), consumed = -inventoryDelta(before, after, id);
          if (number(now.food) > number(player.food) || consumed > 0) return result(true, `Consumed ${id}`, { foodBefore: player.food, foodAfter: now.food, consumed });
          await s.sleep();
        }
        throw new Error("consumption unverified");
      } finally { if (env.signal.reason !== REFLEX_OWNS_BODY) await env.bridge.rpc("control.stopUsing", {}, { timeoutMs: 3000 }); }
    }
    case "attack": {
      const target = string(args.target), entities = list((await s.rpc("perception.entities", { radius: 64 })).entities);
      let matching = entities.filter(e => e.uuid === target || e.type === itemIdSafe(target));
      if (!matching.length) {
        const named = list((await s.rpc("vision.describeScene", { maxDistance: 64 })).entities).filter(e => e.name === target);
        matching = entities.filter(e => named.some(n => n.uuid === e.uuid));
      }
      if (matching.length !== 1) throw new Error("target ambiguous");
      const entity = matching[0]!, uuid = string(entity.uuid), health = number(entity.health);
      await s.go(pos(entity), 2);
      const end = Math.min(s.deadline, Date.now() + 10000);
      while (Date.now() < end) {
        const current = list((await s.rpc("perception.entities", { radius: 64 })).entities).find(e => e.uuid === uuid);
        if (!current) throw new Error("damage unverified: target absent, not proof of kill");
        if (number(current.health) < health) return result(true, "Observed damage to target", { uuid, healthBefore: health, healthAfter: current.health });
        if (distance(pos(await s.player()), pos(current)) > 3) throw new Error("out of reach");
        await s.rpc("interact.attackEntity", { uuid });
        await s.sleep(1000);
      }
      throw new Error("damage unverified");
    }
    case "chest_deposit": case "chest_withdraw": {
      const id = itemId(string(args.item)), count = number(args.count), take = name === "chest_withdraw";
      const block = await s.block(pos(args));
      if (!["minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel"].includes(string(block.id))) throw new Error("chest inaccessible");
      const menu = await s.open(pos(args), ["minecraft:generic_9x3", "minecraft:generic_9x6"]), before = await s.inventory();
      try {
        await s.transfer(id, count, take);
        const after = await s.inventory(), afterMenu = await s.menu(), change = inventoryDelta(before, after, id), containerChange = menuCount(afterMenu, id) - menuCount(menu, id);
        const ok = change === (take ? count : -count) && containerChange === -change;
        return result(ok, ok ? `Transferred exactly ${count} ${id}` : "transfer unverified", { item: id, inventoryDelta: change, containerDelta: containerChange });
      } finally { await s.close(); }
    }
    case "drop": {
      const id = itemId(string(args.item)), count = number(args.count), before = await s.inventory();
      if (inventoryStacks(before).filter(v => v.id === id).reduce((n, v) => n + number(v.count), 0) < count) throw new Error("insufficient items");
      let left = count;
      while (left > 0) {
        const stack = inventoryStacks(await s.inventory()).find(v => v.id === id);
        if (!stack) throw new Error("drop unverified");
        const n = Math.min(left, number(stack.count));
        if (n === number(stack.count)) await s.rpc("inventory.dropSlot", { slot: number(stack.slot), wholeStack: true });
        else {
          await s.hold(id);
          for (let i = 0; i < n; i++) await s.rpc("interact.dropItem", { wholeStack: false });
        }
        await s.sleep(250);
        left -= n;
      }
      const decrease = -inventoryDelta(before, await s.inventory(), id), items = await s.rpc("perception.entities", { radius: 16, kinds: ["item"] });
      return result(decrease === count, decrease === count ? `Dropped exactly ${count} ${id}` : "drop unverified", { item: id, decrease, nearbyDrops: items.entities });
    }
    case "chat_say": {
      if (/^[\s]*[/#]/.test(string(args.text))) throw new Error("public text only; use run_command");
      const sent = await env.chat.say(string(args.text));
      s.check(); return { ...sent, observedDelta: sent.observedDelta ?? {} };
    }
    case "chat_reply": {
      const sent = await env.chat.reply(string(args.to), string(args.text), true);
      s.check(); return { ...sent, observedDelta: sent.observedDelta ?? {} };
    }
    case "run_command": {
      const command = redact(string(args.command).trim()), token = command.split(/\s+/)[0]!;
      if (!command.startsWith("/") || !env.config.commands.allowlist.includes(token)) throw new Error("command_not_allowed");
      const travel = token === "/home" || token === "/spawn";
      const before = travel ? await s.player() : null;
      const sent = await s.rpc("qc.chat.send", { text: command });
      if (sent.sent !== true) return result(false, String(sent.rejected ?? "command outcome unverified"), sent);
      if (!before) return result(true, "Command submitted; no observable outcome claimed", { submitted: command });
      const end = Math.min(s.deadline, Date.now() + 10000);
      while (Date.now() < end) {
        const after = await s.player();
        if (after.dimension !== before.dimension || distance(pos(after), pos(before)) > 1) return result(true, "Command submitted and travel observed", { before: pos(before), after: pos(after), dimension: after.dimension });
        await s.sleep();
      }
      return result(false, "command outcome unverified", { submitted: command, before: pos(before), after: pos(await s.player()) });
    }
    case "remember": {
      const fields = [args.x, args.y, args.z], provided = fields.filter(v => v !== undefined).length;
      if (provided !== 0 && provided !== 3) throw new Error("location requires x, y and z together");
      const session = await s.rpc("session.info");
      const at = provided ? pos(args) : ["place", "chest", "station", "owned", "authorized"].includes(string(args.kind)) ? pos(await s.player()) : null;
      const place = { kind: string(args.kind), name: string(args.name), note: `${string(args.note)} [server: ${string(session.worldId)}]`, pos: at, dimension: string(session.dimension), at: Date.now() };
      try { await env.notes.update(n => { n.places = n.places.filter(p => !(p.name === place.name && p.dimension === place.dimension && p.note.includes(`[server: ${string(session.worldId)}]`))); n.places.push(place); }); }
      catch { throw new Error("memory write failed"); }
      s.check();
      const persisted = env.notes.get().places.some(p => p.name === place.name && p.note === place.note && p.at === place.at);
      return result(persisted, persisted ? "Persisted note" : "memory write failed", { place });
    }
    case "recall": {
      try {
        const query = string(args.query).toLowerCase(), session = await s.rpc("session.info");
        const matches = env.notes.get().places.filter(p => `${p.kind} ${p.name} ${p.note}`.toLowerCase().includes(query)).map(p => ({ ...p, ageMs: Date.now() - p.at, currentServer: session.worldId, currentDimension: session.dimension, sameDimension: p.dimension === session.dimension }));
        return result(true, matches.length ? `Found ${matches.length} notes (historical, not fresh inventory)` : "No matching notes", { matches });
      } catch { throw new Error("memory read failed"); }
    }
    case "set_goal": {
      outcomes.delete(env.bridge);
      return result(true, "Goal update requested, not achieved", { goal: string(args.text) });
    }
    case "finish_goal": {
      const summary = string(args.summary), recorded = outcomes.get(env.bridge) ?? [];
      const abandoned = /^abandoned:/i.test(summary);
      if (!abandoned && !recorded.some(r => r.ok)) return result(false, "no successful tool outcome recorded for this goal; act first or finish with 'abandoned: <reason>'");
      outcomes.delete(env.bridge);
      return result(true, "Goal closure requested against recorded outcomes, not inferred achievement", { goalFinished: summary, evidence: recorded.map(r => ({ summary: r.summary, observedDelta: r.observedDelta })) });
    }
    case "wait": {
      const started = Date.now();
      await s.sleep(number(args.seconds) * 1000);
      return result(true, "Requested wait elapsed", { elapsedMs: Date.now() - started });
    }
    case "stop": {
      const failed = await stopMotion(env);
      const task = await s.rpc("qc.baritone.status"), player = await s.player(), snap = await tickSnapshot(env);
      const motion = object(player.motion);
      const ok = !failed.length && task.active === false && player.usingItem === false && Math.hypot(number(motion.x), number(motion.z)) < .05;
      return result(ok, ok ? "Synthetic actions stopped and task inactive" : "stop unverified", { task, player, snap, failed });
    }
    case "harness_info": {
      const snippets = await searchHarness(string(args.question), resolve(import.meta.dirname, ".."));
      s.check();
      return result(snippets.length > 0, snippets.length ? "Redacted harness information" : "No matching harness information", { snippets });
    }
    default: throw new Error("unknown tool");
  }
}
function itemIdSafe(value: string): string | null { try { return itemId(value); } catch { return null; } }

export async function executeSkill(name: string, args: ObjectValue, env: SkillEnv): Promise<ToolResult> {
  const seconds = name === "wait" ? number(args.seconds) : 0;
  const s = new Skill(env, name === "wait" ? seconds * 1000 + 5000 : name === "smelt" ? Math.max(120000, number(args.count) * 12000 + 30000) : 120000);
  const body = !["observe", "look_screenshot", "chat_say", "chat_reply", "remember", "recall", "set_goal", "finish_goal", "wait", "harness_info"].includes(name);
  try {
    s.check();
    const answer = await dispatch(name, args, s);
    s.check();
    if (answer.ok && body && name !== "stop") {
      const evidence = outcomes.get(env.bridge) ?? [];
      evidence.push(answer); outcomes.set(env.bridge, evidence.slice(-16));
    }
    return answer;
  } catch (error) {
    const interrupted = env.signal.aborted;
    // A Java reflex owns the body: releasing inputs now would cancel it (e.g. eating).
    const releaseBody = env.signal.reason !== REFLEX_OWNS_BODY;
    const failedStops = releaseBody && (body || interrupted) ? await stopMotion(env) : [];
    try { await s.close(); } catch { s.observed.cursorRecoveryRequired = true; }
    if (body) {
      const settled = await Promise.all(["player.getState", "player.getInventory", "qc.baritone.status"].map(async method => {
        try { return [method, await env.bridge.rpc(method, {}, { timeoutMs: 3000 })] as const; }
        catch { return [method, null] as const; }
      }));
      s.observed.settledAfterFailure = Object.fromEntries(settled);
    }
    return result(false, interrupted ? "interrupted" : error instanceof Error ? error.message : "skill failed", { ...s.observed, failedStops });
  }
}
