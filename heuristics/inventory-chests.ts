// Keeps the inventory usable: when it is nearly full, steer the model to store surplus in its OWN chest,
// and block `drop`, which only loops (dropped items land at the agent's feet and are picked straight back up).
import type { Heuristic, Observation } from "../controller/types.ts";

const LOW_FREE_SLOTS = 4;
// Bulk blocks to store first; tools, armour, food and goal materials stay in the inventory.
const BULK = /^minecraft:(cobblestone|cobbled_deepslate|dirt|coarse_dirt|gravel|sand|red_sand|stone|deepslate|andesite|diorite|granite|tuff|calcite|netherrack|flint|rotten_flesh|wheat_seeds)$/;

function freeSlots(obs: Observation): number | null {
  const inv = obs.inventory;
  return inv && typeof inv === "object" && "freeSlots" in inv && typeof inv.freeSlots === "number" ? inv.freeSlots : null;
}

/** Chests this agent owns: blocks it placed (ownBlocksNearby) plus places it remembered with kind "chest". */
function ownChests(obs: Observation, notes: Readonly<Record<string, unknown>>): string[] {
  const placed = Array.isArray(obs.ownBlocksNearby) ? obs.ownBlocksNearby : [];
  const nearby = placed.filter((b): b is [number, number, number, string] => Array.isArray(b) && b[3] === "minecraft:chest").map(([x, y, z]) => `${x} ${y} ${z}`);
  const places = Array.isArray(notes.places) ? notes.places : [];
  const remembered = places.flatMap(p => p && typeof p === "object" && "kind" in p && p.kind === "chest" && "pos" in p && Array.isArray(p.pos) ? [p.pos.join(" ")] : []);
  return [...new Set([...nearby, ...remembered])];
}

function bulkItems(obs: Observation): string[] {
  const inv = obs.inventory;
  const counts = inv && typeof inv === "object" && "counts" in inv && inv.counts && typeof inv.counts === "object" ? inv.counts as Record<string, unknown> : {};
  return Object.keys(counts).filter(id => BULK.test(id));
}

const heuristic: Heuristic = {
  name: "inventory-chests",
  priority: 50,
  onObservation(obs, ctx) {
    const free = freeSlots(obs);
    if (free === null || free > LOW_FREE_SLOTS) return;
    const chests = ownChests(obs, ctx.notes);
    const bulk = bulkItems(obs);
    return [
      `Inventory nearly full (${free} free slots): crafting and pickups will fail. Free space before continuing.`,
      chests.length
        ? `Deposit surplus with chest_deposit into a chest you own at ${chests.join(" | ")}.`
        : `No chest of yours is nearby or remembered (recall kind "chest" if you used one before): otherwise craft a chest (8 planks), place_block it near home, remember it with kind "chest", then chest_deposit into it.${free === 0 ? " With 0 free slots the chest has nowhere to go: first place_block something you carry (e.g. your crafting table, which you need anyway, or a bulk block) to free a slot." : ""}`,
      `Store bulk blocks first${bulk.length ? ` (${bulk.join(", ")})` : ""}; keep tools, weapons, armour, food, torches and materials for the current goal. Never use other players' chests. Do not drop items: they get picked straight back up.`,
    ];
  },
  onPlanProposed(call, obs) {
    if (call.name !== "drop") return;
    // The operator can still ask for a drop explicitly in a terminal instruction.
    const goals = Array.isArray(obs.goals) ? obs.goals : [];
    if (goals.some(g => typeof g === "string" && /\bdrop\b/i.test(g))) return;
    return { veto: "drop is blocked (inventory-chests heuristic): dropped items land at your feet and are picked straight back up. Store surplus in your own chest with chest_deposit instead." };
  },
};
export default heuristic;
