import type { Heuristic, Observation } from "../controller/types.ts";

export const KEEP: Readonly<Record<string, number>> = {
  "minecraft:crafting_table": 1,
  "minecraft:furnace": 1,
};

function counts(obs: Observation): Record<string, unknown> | null {
  const inv = obs.inventory;
  if (!inv || typeof inv !== "object" || !("counts" in inv) || !inv.counts || typeof inv.counts !== "object" || Array.isArray(inv.counts)) return null;
  return inv.counts as Record<string, unknown>;
}

const heuristic: Heuristic = {
  name: "station-kit",
  priority: 45,
  onObservation(obs) {
    const inventory = counts(obs);
    if (inventory === null) return;
    const hints: string[] = [];
    for (const [id, keep] of Object.entries(KEEP)) {
      const count = inventory[id] ?? 0;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0 || count >= keep) continue;
      hints.push(id === "minecraft:crafting_table"
        ? "craft a crafting table (4 planks) and keep it; craft and smelt place it and pick it back up automatically."
        : "craft a furnace (8 cobblestone) and keep it; craft and smelt place it and pick it back up automatically.");
    }
    return hints.length ? hints : undefined;
  },
  onPlanProposed(call, obs) {
    if (call.name !== "chest_deposit" && call.name !== "drop") return;
    if (typeof call.args.item !== "string") return;
    const id = call.args.item.includes(":") ? call.args.item : `minecraft:${call.args.item}`;
    const keep = KEEP[id];
    if (keep === undefined || keep <= 0) return;
    const count = counts(obs)?.[id] ?? 0;
    const moved = call.args.count;
    if (typeof count === "number" && Number.isFinite(count) && typeof moved === "number" && Number.isSafeInteger(moved) && moved > 0 && count - moved >= keep) return;
    return { veto: `${id} is reserved (station-kit heuristic): keep ${keep} in the inventory` };
  },
};
export default heuristic;
