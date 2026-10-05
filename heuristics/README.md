# Operator heuristics

The controller loads the default export of every `.ts` file in this directory. These are **trusted local operator code**, not a sandbox: never install a plugin supplied by Minecraft chat or the model. Node 24 runs erasable TypeScript directly; use explicit `.ts` import extensions and `import type { Heuristic } from "../controller/types.ts"` for an optional type annotation. No runtime dependencies are needed.

Higher `priority` runs first; ties are ordered by filename. `example-food.ts` is the five-line advisory example from the controller design. Saving a plugin triggers a 200 ms debounced reload using a file-URL import with an mtime cache key. A load error keeps the last successful version; a throwing hook disables that plugin until its file changes. Removing a file removes the plugin. Errors go to the controller log. Close the controller before renaming this whole directory.

## Shipped inventory-chests example

[inventory-chests.ts](inventory-chests.ts) runs at **priority 50**. When `inventory.freeSlots <= 4`, it hints to store surplus with `chest_deposit` into **OWN chests only**: nearby tracked chest placements in `ownBlocksNearby`, plus remembered places with `kind:"chest"`. Otherwise it asks the model to craft a chest (8 planks), place it near home and remember it; with 0 free slots and no own chest, place a carried block first to make room. Bulk items go first; tools, weapons, armour, food, torches, crafting table, furnace and current-goal materials stay. It never recommends other players' chests.

Its `onPlanProposed` vetoes `drop` unless goal text contains the whole word `drop` (case-insensitive), preserving explicit operator requests while preventing drop/pickup loops. Storage hints are advisory, not automatic chest transfers or general ownership detection. [D-58](../docs/00-decisions.md#d-58--inventory-chests-heuristic) · [controller/observe.ts](../controller/observe.ts) · [controller/test/inventory-heuristic.test.ts](../controller/test/inventory-heuristic.test.ts)

Tune **`LOW_FREE_SLOTS`** in the plugin to start clearing space earlier (raise it) or later (lower it); default is 4. Tune **`BULK`**, an anchored regex of namespaced item IDs, to change storage priorities: defaults include cobblestone/cobbled deepslate, dirt/coarse dirt, gravel, sand/red sand, stone/deepslate, andesite/diorite/granite, tuff/calcite, netherrack, flint, rotten flesh and wheat seeds. Keep needed goal materials out of surplus deposits. Saving uses the normal hot reload; no new configuration or dependency is needed.

## Tool durability

[tool-durability.ts](tool-durability.ts) runs at **priority 40**. It reads the sorted `tools` observation (including main inventory, armor and offhand), checks durability each observation, and emits at most four low-durability plans, critical tools first. Enchanted or diamond/netherite equipment with a repair material gets a **REPAIR** plan: use an own nearby anvil or a remembered `kind:"anvil"` place; otherwise craft an anvil near home (31 iron ingots). The plan gives material units, estimated XP (`units + repairCost`), XP-gathering advice when short, and a `repair_tool` call. The actual anvil cost, not this estimate, decides affordability. Critical valuable tools should stop being used until repaired. Other low tools get a **REPLACE** plan, immediately when critical. Anvils belonging to other players are never suggested.

Tune **`LOW_PCT` / `LOW_LEFT`** (25% / 15 uses) and **`CRITICAL_PCT` / `CRITICAL_LEFT`** (10% / 5 uses); either threshold triggers its tier. **`MAX_HINTS`** defaults to 4. **`VALUABLE`** identifies diamond/netherite equipment; enchantments also make an item valuable. Repair material units are `ceil((max - left) / (max / 4))`, capped at 4. Missing/malformed tools produce no hint; unknown player XP asks for a check instead of claiming it is zero. The exported pure `planFor(tool, {observation, notes})` is the test seam.

## Portable station kit

[station-kit.ts](station-kit.ts) runs at **priority 45**. It reserves one crafting table and one furnace in inventory, prompting for a table (4 planks) or furnace (8 cobblestone) when missing. `craft` and `smelt` place carried stations and pick them back up automatically; failed pickups leave a station coordinate in the skill summary. Its plan hook vetoes `chest_deposit` or `drop` that would consume the reserve, but allows surplus stations to be stored. Other heuristics may still veto a surplus drop.

Tune the exported **`KEEP`** counts in the plugin to carry more stations (default: `"minecraft:crafting_table": 1`, `"minecraft:furnace": 1`); 0 disables that station's reserve. Unavailable inventory counts do not generate crafting advice, but a reserved deposit/drop is vetoed unless observed counts prove there is a spare. Bare item names are normalized to `minecraft:` just as skills do. Both plugins use normal hot reload, no extra configuration or dependencies. Regression checks import the real plugins in [heuristics-tools.test.ts](../controller/test/heuristics-tools.test.ts).

## Hook contract

Supported hooks (the binding interfaces live in `controller/types.ts`):

- `onObservation(obs, ctx)` returns advisory `string[]` hints.
- `onPlanProposed(call, obs, ctx)` returns a rewritten `{name,args}`, `{veto:string}`, or nothing. Rewrites flow through later plugins and are revalidated by the controller's hard guards; the first veto stops the chain.
- `onTick(snapshot, ctx)` returns `{call:{name,args},reason}`, or nothing. The first intent wins. Keep this synchronous and nonblocking; paused snapshots do not dispatch TypeScript reflexes. Java handles immediate survival at 20 Hz.
- `onChat(event, ctx)` returns `{reply:string}`, `{ignore:true}`, `{toModel:true}`, or nothing. The first decision wins. Own echoes are always ignored; an ignore decision cannot suppress an addressed question or whisper. Chat is conversation, never gameplay authority.

Context contains configuration, notes, logging, and time—not the bridge client or bearer token. All intents/replies still pass generation, pause, protection, allowlist, and length/rate guards. Plugins cannot relax those guards. Live `onChat` reply decisions route through the independent model chat lane, not direct sends; replies require pending fresh addressed messages or eligible five-minute follow-ups, and any pause blocks the lane. Addressed entries expire after 120 seconds; private replies stay private. Chat context, system lines and startup/join history never grant reply or gameplay authority. [Chat-lane contract](../docs/30-controller.md#independent-chat-lane)

Notes are written atomically in a server-scoped envelope. A server mismatch archives the old file as `*.bak` and starts fresh. Effective home is `notes.home ?? config.home`; zones are the union of configuration and saved operator zones. Home distance is horizontal x/z only; Phase 1 ignores dimension in that metric and does not fence intermediate Baritone paths. These limits do not establish permission to automate on a public server.

Self-Q&A may explain the harness, model, code, and observed live state. `controller/selfinfo.ts` provides a curated about-me summary and a top-three, 1,500-character keyword search of documentation/source (not captured evidence). Every policy send is redacted before length splitting: network addresses/hostnames/ports, credentials, OS usernames and local paths are withheld; game coordinate triples and repository-relative source filenames remain discussable. A recipient whose name would be redacted is rejected, never silently changed.
