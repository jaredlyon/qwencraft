import type { Heuristic, Observation } from "../controller/types.ts";

const LOW_PCT = 25, LOW_LEFT = 15;
const CRITICAL_PCT = 10, CRITICAL_LEFT = 5;
const MAX_HINTS = 4;
const VALUABLE = /^minecraft:(diamond|netherite)_/;
const ANVILS = ["minecraft:anvil", "minecraft:chipped_anvil", "minecraft:damaged_anvil"];

type Tool = { id: string; left: number; max: number; pct: number; enchanted?: unknown; enchantments?: unknown; repairWith?: unknown; repairCost?: unknown };
type PlanContext = { observation: Observation; notes: Readonly<Record<string, unknown>> };

function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  return typeof tool.id === "string"
    && typeof tool.left === "number" && Number.isFinite(tool.left) && tool.left >= 0
    && typeof tool.max === "number" && Number.isFinite(tool.max) && tool.max > 0 && tool.left <= tool.max
    && typeof tool.pct === "number" && Number.isFinite(tool.pct) && tool.pct >= 0 && tool.pct <= 100;
}

function critical(tool: Tool): boolean {
  return tool.pct <= CRITICAL_PCT || tool.left <= CRITICAL_LEFT;
}

function position(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(n => typeof n === "number" && Number.isFinite(n))) return null;
  return value.join(" ");
}

function ownAnvils(ctx: PlanContext): string[] {
  const placed = Array.isArray(ctx.observation.ownBlocksNearby) ? ctx.observation.ownBlocksNearby : [];
  const nearby = placed.flatMap(block => {
    if (!Array.isArray(block) || typeof block[3] !== "string" || !ANVILS.includes(block[3])) return [];
    const pos = position(block.slice(0, 3));
    return pos === null ? [] : [pos];
  });
  const places = Array.isArray(ctx.notes.places) ? ctx.notes.places : [];
  const remembered = places.flatMap(place => {
    if (!place || typeof place !== "object" || !("kind" in place) || place.kind !== "anvil" || !("pos" in place)) return [];
    const pos = position(place.pos);
    return pos === null ? [] : [pos];
  });
  return [...new Set([...nearby, ...remembered])];
}

/** Pure advisory plan for one observed tool; missing or malformed durability is not actionable. */
export function planFor(tool: unknown, ctx: PlanContext): string | null {
  if (!isTool(tool) || (tool.pct > LOW_PCT && tool.left > LOW_LEFT)) return null;
  const repairWith = Array.isArray(tool.repairWith) ? tool.repairWith.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const enchanted = tool.enchanted === true || (Array.isArray(tool.enchantments) && tool.enchantments.some(e => typeof e === "string" && e.length > 0));
  if (!(enchanted || VALUABLE.test(tool.id)) || repairWith.length === 0) {
    return `REPLACE ${tool.id} (${tool.left}/${tool.max}): gather materials and craft a replacement now, before it breaks; keep using the old one until then.${critical(tool) ? " craft the replacement immediately." : ""}`;
  }
  const anvils = ownAnvils(ctx);
  const units = Math.min(4, Math.ceil((tool.max - tool.left) / (tool.max / 4)));
  const repairCost = typeof tool.repairCost === "number" && Number.isFinite(tool.repairCost) && tool.repairCost >= 0 ? tool.repairCost : 0;
  const xp = units + repairCost;
  const player = ctx.observation.player;
  const level = player && typeof player === "object" && "xpLevel" in player && typeof player.xpLevel === "number" && Number.isFinite(player.xpLevel) && player.xpLevel >= 0 ? player.xpLevel : null;
  return [
    `REPAIR ${tool.id} (${tool.left}/${tool.max}):`,
    anvils.length ? `use an anvil you own at ${anvils.join(" | ")}; never use other players' anvils.` : "craft an anvil (3 iron blocks + 4 iron ingots = 31 iron ingots) and place it near home.",
    `Repair material: ${units} units (${repairWith.join(" or ")}), capped at 4 per repair.`,
    `Estimated XP: ${xp} levels (${units} material + ${repairCost} prior work); ${level === null ? "current XP unknown: check player XP first" : `have ${level}`}.`,
    ...(level !== null && level < xp ? ["gain XP first: mine coal/redstone/lapis/quartz ore, smelt items, or kill mobs."] : []),
    "then call repair_tool with the item and the owned anvil's x/y/z; the anvil's actual cost decides whether repair is affordable.",
    ...(critical(tool) ? ["stop using it until repaired; switch to another tool."] : []),
  ].join(" ");
}

const heuristic: Heuristic = {
  name: "tool-durability",
  priority: 40,
  onObservation(obs, ctx) {
    const tools = Array.isArray(obs.tools) ? obs.tools.filter(isTool) : [];
    const hints = tools.sort((a, b) => Number(critical(b)) - Number(critical(a)) || a.pct - b.pct || a.left - b.left)
      .flatMap(tool => {
        const plan = planFor(tool, { observation: obs, notes: ctx.notes });
        return plan === null ? [] : [plan];
      }).slice(0, MAX_HINTS);
    return hints.length ? hints : undefined;
  },
};
export default heuristic;
