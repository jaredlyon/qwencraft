import type { Config, Notes, Observation, SkillEnv, TickSnapshot, ToolResult, ChatEvent, Vec3 } from "./types.ts";

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

export function withinHome(c: Config, notes: Notes, target: Vec3): boolean {
  const home = notes.home ?? c.home;
  // Phase 1 has no dimension in Vec3 and does not fence the intermediate path.
  return home !== null && target.every(Number.isFinite) && horizontalDistance(home, target) <= c.selfGoal.radius;
}

function compact(value: unknown, budget: number, field: string, omitted: string[]): unknown {
  if (JSON.stringify(value)?.length <= budget) return value;
  omitted.push(field);
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      if (JSON.stringify([...kept, item]).length > budget) break;
      kept.push(item);
    }
    return kept;
  }
  if (typeof value === "string") return value.slice(0, Math.max(0, budget - 2));
  const object = record(value);
  if (Object.keys(object).length) {
    const keys = Object.keys(object);
    return Object.fromEntries(keys.map(key => [key, compact(object[key], Math.floor(budget / keys.length) - key.length - 4, `${field}.${key}`, omitted)]));
  }
  return null;
}

export async function observe(env: SkillEnv, extra: { goal: string | null; lastResult: ToolResult | null; recentChat: ChatEvent[]; hints: string[] }): Promise<Observation> {
  const at = Date.now();
  const acquiredAt: Record<string, number> = {};
  const unavailable: Record<string, string> = {};
  const omitted: string[] = [];
  const reads: Array<[string, string, Record<string, unknown>]> = [
    ["session", "session.info", {}], ["player", "player.getState", {}],
    ["inventory", "player.getInventory", {}], ["equipment", "player.getEquipment", {}],
    ["tools", "qc.inventory.tools", {}],
    ["effects", "player.getStatusEffects", {}],
    ["terrain", "perception.scan", { radius: 1, find: env.config.protect.naturalBlocks.filter(id => id.endsWith("_log") || id.endsWith("_ore")).slice(0, 32), findLimit: 16 }],
    ["entities", "perception.entities", { radius: 16 }], ["timeWeather", "qc.world.state", {}],
    ["control", "qc.control.state", {}], ["task", "qc.baritone.status", {}],
  ];
  const values = Object.fromEntries(await Promise.all(reads.map(async ([field, method, params]) => {
    try {
      const value = await env.bridge.rpc(method, params, { signal: env.signal });
      acquiredAt[field] = Date.now();
      return [field, value] as const;
    } catch (error) {
      unavailable[field] = error instanceof Error ? error.message : String(error);
      return [field, null] as const;
    }
  })));
  try {
    const player = record(values.player);
    const { x, y, z } = player;
    if (![x, y, z].every(v => typeof v === "number" && Number.isFinite(v))) throw new Error("player position unavailable");
    const placed = record(await env.bridge.rpc("qc.placed.near", { x, y, z, radius: 6 }, { signal: env.signal }));
    if (!Array.isArray(placed.blocks)) throw new Error("placed blocks unavailable");
    values.ownBlocksNearby = placed.blocks.slice(0, 32).map((raw): [number, number, number, string] => {
      const b = record(raw);
      if (typeof b.x !== "number" || !Number.isFinite(b.x) || typeof b.y !== "number" || !Number.isFinite(b.y) || typeof b.z !== "number" || !Number.isFinite(b.z) || typeof b.id !== "string") throw new Error("placed block unavailable");
      return [b.x, b.y, b.z, b.id];
    });
    acquiredAt.ownBlocksNearby = Date.now();
  } catch (error) {
    unavailable.ownBlocksNearby = error instanceof Error ? error.message : String(error);
    values.ownBlocksNearby = null;
  }
  env.signal.throwIfAborted();
  const rawInventory = values.inventory;
  if (rawInventory !== null) {
    const inv = record(rawInventory);
    const counts: Record<string, number> = {};
    const stacks = [...(Array.isArray(inv.hotbar) ? inv.hotbar : []), ...(Array.isArray(inv.main) ? inv.main : []), ...(Array.isArray(inv.armor) ? inv.armor : []), inv.offhand];
    for (const stack of stacks) {
      const item = record(stack);
      if (typeof item.id === "string" && typeof item.count === "number" && Number.isFinite(item.count)) counts[item.id] = (counts[item.id] ?? 0) + item.count;
    }
    // player.getInventory omits empty slots, so free storage = 36 hotbar+main slots minus the stacks listed.
    const stored = (Array.isArray(inv.hotbar) ? inv.hotbar.length : 0) + (Array.isArray(inv.main) ? inv.main.length : 0);
    values.inventory = { counts, freeSlots: Math.max(0, 36 - stored), selectedSlot: inv.selectedSlot, hotbar: inv.hotbar, armor: inv.armor, offhand: inv.offhand, equipment: values.equipment };
  }
  delete values.equipment;
  if (values.tools !== null) {
    const tools = record(values.tools).tools;
    values.tools = (Array.isArray(tools) ? tools : []).map(raw => {
      const tool = record(raw), max = Number(tool.maxDamage), left = max - Number(tool.damage);
      const enchantments = Array.isArray(tool.enchantments) ? tool.enchantments : [];
      return { slot: tool.slot, id: tool.id, left, max, pct: Math.round(100 * left / max), enchanted: enchantments.length > 0, enchantments, repairWith: tool.repairWith, repairCost: tool.repairCost };
    }).sort((a, b) => a.pct - b.pct);
  }
  const notes = env.notes.get();
  // Put must-consider messages first so a large ambient batch cannot crowd them out.
  const chat = [...extra.recentChat].sort((a, b) => Number(b.mentionsMe || b.kind === "whisper") - Number(a.mentionsMe || a.kind === "whisper"));
  const budgets: Record<string, number> = { session: 500, player: 1100, inventory: 2700, tools: 1500, effects: 600, terrain: 2800, entities: 2000, timeWeather: 300, control: 300, task: 500, ownBlocksNearby: 2200, recentChat: 1800, lastResult: 900, hints: 500, goals: 500, zones: 400 };
  const observation: Observation = { ...values, goals: extra.goal === null ? [] : [extra.goal], home: notes.home ?? env.config.home, zones: [...env.config.protect.zones, ...notes.zones], recentChat: chat, lastResult: extra.lastResult, hints: extra.hints };
  for (const [field, budget] of Object.entries(budgets)) observation[field] = compact(observation[field], budget, field, omitted);
  observation.metadata = { at, acquiredAt, unavailable, omitted, scanRadiusUnit: "chunks", entityRadiusUnit: "blocks", chatOrder: "addressed-first", terrainScope: "loaded chunks only", entityLimit: 64 };
  return observation;
}

export async function tickSnapshot(env: SkillEnv): Promise<TickSnapshot> {
  const [rawPlayer, rawControl, rawEntities] = await Promise.all([
    env.bridge.rpc("player.getState", {}, { signal: env.signal }),
    env.bridge.rpc("qc.control.state", {}, { signal: env.signal }),
    env.bridge.rpc("perception.entities", { radius: 8, kinds: ["hostile"] }, { signal: env.signal }),
  ]);
  env.signal.throwIfAborted();
  const player = record(rawPlayer), control = record(rawControl), entities = record(rawEntities);
  const nums = [player.health, player.food, player.x, player.y, player.z];
  if (!nums.every(v => typeof v === "number" && Number.isFinite(v)) || typeof control.paused !== "boolean" || !Array.isArray(entities.entities)) throw new Error("tick snapshot unavailable");
  return { health: player.health as number, food: player.food as number, pos: [player.x as number, player.y as number, player.z as number], paused: control.paused, hostilesNear: entities.entities.filter(e => record(e).kind === "hostile").length };
}
