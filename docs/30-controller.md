# Phase-1 controller

The implemented TypeScript/Node controller runs on the tower and drives the visible Fabric client through MCPFabric. D-55 splits Qwen work into body and chat lanes, single-flight within each lane; up to two requests may be in flight on Spark. `main.ts` supervises `run.ts` for goal-preserving restart. Local bench gameplay, restart restoration and a private reply during active mining have been exercised; the full chat-lane matrix and RayCraft acceptance remain pending. [D-00, D-01, D-03, D-04, D-07, D-38, D-53, D-55] [controller/main.ts](../controller/main.ts) [Ctl-main] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

Decisions are indexed in [00-decisions.md](00-decisions.md); topology, companion RPCs, chat/safety, build acceptance, and sources are in [10-architecture.md](10-architecture.md), [20-companion-mod.md](20-companion-mod.md), [40-chat-and-safety.md](40-chat-and-safety.md), [50-install-and-verification.md](50-install-and-verification.md), and [references.md](references.md). [D-00]

## 1. Modules and configuration

Use one controller process and ordinary modules, not MCP sessions or a second agent runtime; MCPFabric's existing agent directory is a useful responsibility split, while this design owns its skills and lifecycle directly. [D-04] [D-07] [M-layout]

| Under `controller/` | Responsibility | Design basis |
|---|---|---|
| `config.ts` | Load `qwencraft.config.json`, validate contract values, project configuration into `qc.config.apply`. | [D-10] [D-26] |
| `bridge.ts` | Authenticated RPC envelopes, transport errors, cancellation, health/capability checks. | [D-07] [M-http] |
| `events.ts` | SSE decoding, cursor recovery, deduplication, lifecycle event dispatch. | [D-14] [M-events] [M-sse] |
| `llm.ts` | Chat-completions request, tools, reasoning/history filtering, request abort. | [D-09] [D-21] |
| `loop.ts` | Body generation/skill ownership, wake batching, interruption/self-goals; independent single-flight chat lane and five-minute sender conversation windows. | [D-19, D-20, D-54, D-55] |
| `tools.ts` | Exact curated tool schemas and dispatch to skills; no raw-RPC tool. | [D-09] [D-10] |
| `skills.ts` | Deterministic body compositions and observed postconditions. | [D-07] [D-09] |
| `chat-policy.ts` | Untrusted chat, addressed-message routing, public/private reply budgeting and D-44 redaction; follow-up eligibility is tracked by the loop. | [D-48, D-54, D-17, D-18, D-36, D-44] |
| `heuristics.ts` | Load `heuristics/*.ts`, ordered hooks, hot reload and exception isolation. | [D-25] |
| `memory.ts` | Rolling summary and `notes.json`; no vector store. | [D-33] |
| `console.ts` | Terminal-only instruction parsing and operator commands. | [D-05] |
| `main.ts` | Supervisor: launch `run.ts` with inherited terminal I/O/arguments; relaunch only on restart exit code 75. | [D-53] |
| `run.ts` | Startup, lease/recovery, shutdown, restart-state save/restore and JSONL transcript; startup chat watermark and five-second join-history routing. | [D-11, D-24, D-34, D-53, D-57] |
| `selfinfo.ts` | Curated `ABOUT_ME`, shared outgoing redaction, bounded docs/code search for `harness_info`. | [D-43, D-44, D-45] [Ctl-selfinfo] |

Keep these exact configuration keys and initial values; brackets below indicate an operator-supplied list, not a literal JSON value. [D-10] [D-18] [D-21] [D-26] [D-29] [D-48] [D-31] [D-34] [D-36] [D-37]

| Key | Initial value / semantics | Basis |
|---|---|---|
| `llm.baseUrl` | `http://192.168.100.2:8000/v1` | [D-03] [LLM-probe] |
| `llm.model` | `qwen3.8-flash-next` | [D-21] [LLM-probe] |
| `llm.thinking` | `"planning"`: thinking only for a new console instruction and failed-tool replan on that instruction; resume/idle/self-goal/chat/death/successful completion remain off. `"off"` disables thinking entirely. | [D-21, D-46] |
| `chat.nicknames` | `["SirWaffleshnoz"]`; case-insensitive substring matching | [D-48] |
| `chat.wholeWords` | `["jared"]`; case-insensitive whole-word matching | [D-48] |
| `chat.minIntervalMs` | `3000` | [D-18] |
| `chat.maxLen` | `256` | [D-18] |
| `chat.maxLinesPerReply` | `2` | [D-18] |
| `commands.allowlist` | `["/spawn","/home","/sethome","/msg","/r"]` | [D-29] [D-36] |
| `protect.naturalBlocks` | Default list in `qwencraft.config.json` accepted by the operator for RayCraft on 2026-10-04; no inferred permission/ownership for placed natural or crafted blocks. D-49 separately permits unchanged tracked agent placements while active, without widening this list. | [D-26, D-49] [qwencraft.config.json](../qwencraft.config.json) |
| `protect.zones` | `[]`; entries `{name,min:[x,y,z],max:[x,y,z]}`. | [D-26] |
| `home` | `null`; effective anchor is `notes.home ?? config.home`. When both are unset, activation attempts `/home` once and persists verified arrival; failure requests `home set`. | [D-31, D-40] [Ctl-main] |
| `selfGoal.radius` | `256` blocks, measured horizontally in x/z only. | [D-37] [D-39] |
| `reflex.eatAtFood` | `14` | [D-32] |
| `reconnect.maxPerHour` | `3`; reset only after 1 hour continuously connected, not a rolling window. A fourth pre-reset disconnect requires `resume`. Counter is in memory only, not persisted across controller restarts. | [D-34, D-41] [Ctl-main] |
| `reconnect.backoffMs` | `[30000,120000,600000]` | [D-34] |
| `reconnect.stopPatterns` | `["ban","banned","kicked by"]` | [D-34] |
| `lease.ttlMs` | `3000` | [D-11] |
| `lease.intervalMs` | `1000` | [D-11] |
| `server.host` | `raycraft.ddnsfree.com` | [D-02] [server-evidence] |
| `server.port` | `25565` | [D-02] [server-evidence] |

Apply `{reflex,protect,chat,commandAllowlist,nicknames}` through `qc.config.apply`: `ReflexConfig={enabled:boolean,eatAtFood:number}`, `ChatLimits={minIntervalMs:number,maxLen:number}`, `Nicknames={names:string[],wholeWords:string[]}`; map `commands.allowlist` to `commandAllowlist`, `chat.nicknames` to `nicknames.names`, and `chat.wholeWords` to `nicknames.wholeWords`. Enable the configured Java reflex core through `reflex.enabled`, without adding a controller config key. [D-10] [D-18] [D-25] [D-26] [D-48] [D-32] [Mod]

The mod's `qc.chat.mentionsMe` is authoritative for player mentions; whispers qualify independently. Fresh incoming non-self player mentions/whispers enter the chat lane's `mustReply`, while fresh non-self player/whisper messages from a sender replied to within five minutes can enter `followUps` without a name. Other chat is context only; system lines always have `mentionsMe=false`, and history never enters reply routing. Neither chat route wakes the body lane. Plugins cannot weaken lane tool restrictions, mod limits, redaction or the allowlist. [D-14, D-48, D-54, D-55, D-56, D-57, D-18, D-25, D-44] [Mod]

## 2. Bridge client and event recovery

Read the bearer `token` from the same launcher's `.minecraft/config/mcpfabric.config.json`, never from the launcher access token, and never print it; MCPFabric creates/saves a token when blank and defaults to loopback port 25599. [D-07] [D-10] [D-12] [M-config]

Use `http://127.0.0.1:25599/health` for unauthenticated liveness and authenticated `POST /rpc` with `Authorization: Bearer <token>` and `Content-Type: application/json`; the upstream RPC format is `{method,params}` → `{ok:true,result}` or `{ok:false,error:{code,message,data?}}`, not JSON-RPC 2.0. [D-07] [M-http] [M-envelope]

MCPFabric's bridge serialization omits JSON-null members rather than emitting explicit `null`. Treat missing nullable keys as null: status `taskId`/`kind`/`lastPathEvent`, chat `senderUuid`/`senderName`, and pause `reason` are examples observed on the bench. Chat ingestion normalizes absent identity keys to null; an unpaused response need not contain `reason`. [Ctl-main] [Ctl-skills] [D-07, D-14]

At startup inspect `info.status`/`info.capabilities`, confirm the companion methods are registered, apply config, read `qc.control.state`, and remain paused until the operator resumes; no automatic movement should result from discovery alone. [D-10] [D-11] [M-info] [Mod]

The deployment must set MCPFabric `enableWorldWrite=false`, `enableCommands=false`, `enablePlayerControl=true`, `enableVision=true`, `host=127.0.0.1`, `requireAuth=true`; allowlisted player slash-commands use `qc.chat.send`, not upstream administrative `command.run`. [D-10] [D-22] [D-29] [M-config] [Mod]

### SSE and cursors

Upstream `/events` sends unnamed `data:` frames containing `{id,type,gameTime,data}` and polls its queue for up to 15 seconds before sending an idle heartbeat; its SSE subscriber queue can drop overflowing entries, while `EventBus` retains a 2,000-event ring. [M-http] [M-sse] [M-events] [M-event-json]

Subscribe without a type filter, track all numeric event IDs, and process only the companion events below for harness policy; consume upstream events only where a skill needs corroborating evidence, never duplicate native chat ingestion. [D-14] [D-20]

On startup, SSE reconnect, and periodic reconciliation, request `events.getRecent{sinceId}` with an explicit sufficiently large `limit`; open SSE before catch-up, buffer concurrent frames, merge/sort by ID, and deduplicate before advancing the cursor. `events.getRecent` returns `{events,lastId}`, and its default limit is only 50. [D-14] [INFERENCE: recovery algorithm] [M-chat] [M-events]

After setting up the event stream at startup, read the highest current event ID once using `events.getRecent {limit:1}` (reuse the event client's bridge access). Any `qc.chat` with `id <=` that startup watermark is history. Each `qc.join` sets `graceUntil=Date.now()+5000`; any chat processed before it expires is history, including genuinely new lines during the grace. Route history only through `loop.wake('chat history', message)`, never `chat.route`: retain `recentChat` context with no unanswered entry, no follow-up and no lane run. Fresh events after these boundaries use the normal reply rules; ordinary SSE recovery still deduplicates by ID. [D-57, D-14] [Ctl-main] [Ctl-events]

A ring gap or bridge ID reset produces the synthetic local event `controller.history_lost` with `{reason,cursor}` (`id:0`, `gameTime:0`); this is not a `qc.*` mod event. The main controller pauses and invalidates work, aborts lifecycle work, takes fresh control/player/inventory/task snapshots and requires operator `resume`; it never synthesizes missing chat. [Ctl-events] [Ctl-main] [D-11, D-14, D-20]

[VERIFY] Prove recovery with more than the default 50 events, overflow, and a client restart that resets event IDs; scope cursors to the bridge lifetime, not a durable global sequence. [D-14] [M-events]

| Companion event | Controller reaction | Basis |
|---|---|---|
| `qc.chat` | Preserve payload and context; suppress self echoes; history goes only to `wake('chat history', event)`. Fresh player mentions/whispers enter chat-lane `mustReply`, eligible unnamed follow-ups enter `followUps`; system/other lines are context only. No body wake or gameplay authority. | [D-14, D-48, D-54, D-55, D-56, D-57] [Mod] |
| `qc.pause` | Update `{paused,reason}`; invalidate generation and cancel pending body work on pause; no automatic unpause. | [D-11] [D-20] [Mod] |
| `qc.task` | Match `taskId`; accept only `at_goal`, `calc_failed`, `canceled`, `lost_control`; reconcile status and the skill-specific position/inventory postcondition. Only the controller declares `done`/`failed`, never the mod event. | [D-08] [D-20] [D-42] [Mod] [B-events] [B-lifecycle] [B-mine] |
| `qc.reflex` | Pause/invalidate loop work; reactivate only at least 1.5 s after the last reflex event and when fresh `player.getState.usingItem=false`. Java cancels Baritone/MCP work and keeps Baritone canceled every tick during a reflex. This settling heuristic is not an explicit completion event. | [D-20, D-32] [Ctl-main] [mod/src/main/java/dev/qwencraft/control/Reflexes.java](../mod/src/main/java/dev/qwencraft/control/Reflexes.java) |
| `qc.death` | Save `{x,y,z,message}`, cancel old skill, respawn policy below. | [D-24] [Mod] |
| `qc.disconnect` | Cancel work; evaluate `{reason}` against reconnect guardrails and clear the stable-connection timer. | [D-24] [D-34] [D-41] [Mod] |
| `qc.join` | Set five-second chat-history grace, check `{host,port}`, refresh snapshots/configuration, and start the 1-hour stable-connection timer without resetting reconnect accounting on join alone. | [D-24, D-41, D-57] [Mod] |

Send `qc.control.lease{ttlMs:3000}` every 1000 ms independently of LLM requests and long skills; inspect its `{paused,reason}` response, and treat expiry as a pause, never implicit permission to resume. [D-11] [Mod]

Transport abort/timeout is not proof a mutation did not run: upstream main-thread dispatch can finish an already-started call after the caller times out. Re-observe before retrying any craft, transfer, drop, placement, or chat send. [D-07] [D-09] [M-dispatch]

## 3. LLM request and history policy

Request `${llm.baseUrl}/chat/completions` with `model:llm.model`, OpenAI-style `messages`, the exact curated function tools, `tool_choice:"auto"`, and `chat_template_kwargs:{enable_thinking:false}` normally. Under `llm.thinking="planning"`, D-46 permits `enable_thinking:true` only for the initial plan of a new console instruction or a replan after a failed tool on that instruction. Resume, idle/self-goal, chat, death/recovery and successful tool-completion turns do not enable thinking; a failed-tool replan on an active console instruction is the sole completion-related exception. [D-09, D-21, D-46] [LLM-probe]

The captured endpoint emitted native `tool_calls`, exposed reasoning in `message.reasoning`, and accepted a tiny PNG image; this establishes API capability, not Minecraft visual competence or loaded-server latency. [LLM-probe]

The captured template reads `reasoning_content` and preserves historical thinking when `preserve_thinking` is undefined/true (or the assistant turn follows the last user query); `enable_thinking=false` suppresses reasoning-effort instructions and changes the generation prefix, but does not remove historical reasoning already supplied. [LLM-template]

Strip `reasoning`, `reasoning_content`, and historical `<think>…</think>` content from replayed assistant history; retain final assistant content and tool-call IDs/arguments, and append each result as the matching tool message. Do not copy reasoning into public chat, the HUD, memory summaries, or notes. Final model prose is printed to the console only, never used as HUD action text. [Ctl-loop] [D-21] [D-23] [D-33]

Qwen's pinned parser supports consecutive tool calls; execute a returned batch sequentially, never concurrently, with fresh guard/postcondition checks between calls and a generation check before each call. [D-09] [D-20] [V-parser]

No tool may execute until the complete response and arguments have been validated; unknown tools, invalid JSON, ambiguous IDs, or invalid finite coordinates/counts produce a tool failure, not raw-RPC fallback or guessed actions. [D-09] [D-10]

Keep one request in flight **per lane**, including aborted generations until locally settled: body and chat requests may overlap, but two chat turns or two body turns may not. The body deadline is 60 seconds normally and 300 seconds (with `max_tokens` 8192) for thinking-enabled console planning; the chat lane always uses thinking off and a 60-second request deadline. [D-63] Shared Spark capacity is not a latency guarantee. [D-11, D-20, D-21, D-55] [INFERENCE: load caveat]

**2026-10-04 compaction fix:** History compaction sent `tools: []`; vLLM returned HTTP 400, causing the loop to back off and show the old `LLM unavailable` action after every turn even while tasks were progressing. [controller/llm.ts](../controller/llm.ts) now omits empty tools from the request and includes the error response body in `LLM HTTP <code>: <text>`. Compaction failures are also logged through `deps.log` with their error message; the HUD reports retry status rather than replacing the last tool action with an outage label. [Ctl-loop]

The built request sets `max_tokens=1024` normally and `4096` for thinking turns, with `preserve_thinking:false` and the 30/90-second deadlines above. These are bounded implementation defaults, not measured guarantees under concurrent Spark load. [Ctl-llm] [D-21] [INFERENCE: load caveat]

D-46 narrows the earlier planning classification because pre-amendment bench thinking-enabled turns took about **50–82 s**, versus roughly **3–6 s** on ordinary steps—close to the 90-second thinking deadline. This is sampled local evidence, not a controlled benchmark or a promised speedup. The old resume turns that contributed these measurements must not justify thinking on resume under the new rule. Raw transcripts remain private local runtime evidence. [D-46, D-06] [bench/logs/2026-10-05T01-31-21-487Z.jsonl](../bench/logs/2026-10-05T01-31-21-487Z.jsonl) [bench/logs/2026-10-05T01-37-15-335Z.jsonl](../bench/logs/2026-10-05T01-37-15-335Z.jsonl) [bench/logs/2026-10-05T01-48-06-684Z.jsonl](../bench/logs/2026-10-05T01-48-06-684Z.jsonl)

The system prompt includes D-49's rule: “You may break blocks you placed yourself (listed in ownBlocksNearby) with break_block, e.g. to get out of a shelter you built; never break other blocks that are not natural.” Baritone's type-based `blocksToDisallowBreaking` does not gain own-placement exceptions: use `break_block` to dig out before resuming a blocked path. Operator free-zone permission remains a separate hard-guard exception; the prompt cannot widen it or turn chat into breaking authority. [D-49, D-26, D-17] [controller/loop.ts](../controller/loop.ts) [Mod]

The body lane's action-continuity system-prompt clause is exact: “Every reply must contain at least one tool call unless the goal is finished (call finish_goal). There is no wait tool. A task you start runs to completion inside its tool call. If a result says interrupted, obsolete generation discarded, or no action dispatched, that task has STOPPED: re-issue it if it is still needed, never assume it is still running.” Conversation does not schedule or interrupt this lane. [D-51, D-55] [Ctl-loop]

## 4. Curated tools and deterministic skills

There are exactly 28 curated tools, including D-45's `harness_info` and D-61's `repair_tool`; D-51 removes the timer action. The body lane receives this registry minus `chat_say` and `chat_reply`; the chat lane receives only `chat_say`, `chat_reply`, `harness_info`, `observe`. Every tool returns `{ok,summary,observedDelta}`; outcomes come from observed postconditions, not submission alone. Only the subset in the local bench results has gameplay evidence; repair, station pick-up, wider live and complete lane checks remain pending. Tool descriptions explicitly tell the model that `mine`/`collect` find ore themselves: **do not `explore` first**. [Ctl-tools] [Ctl-skills] [D-07, D-09, D-38, D-45, D-51, D-55, D-61, D-62] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

Use inventory deltas for requested **new output**: `collect`, `mine`, `craft`, and `smelt` counts denote units acquired/produced by that call, while `qc.baritone.mine.targetCount` is the desired final matching inventory count; translate the starting inventory explicitly. Baritone counts inventory items rather than broken blocks. [D-09] [INFERENCE: tool quantity interpretation] [B-mine]

Stop cleanup shared by body skills is `qc.baritone.stop`, `interact.stopBreaking`, `control.stopUsing`, `nav.stop`, and `control.stop`; authoritative mod pause additionally clears synthetic attack/use and calls internal `stopMining`, `stopNavigation`, and Baritone `cancelEverything()`. `control.stop` alone is insufficient. Release an open menu with `container.close` only after safely resolving any cursor-held stack. [D-08] [D-11] [M-interact] [M-control] [M-nav] [M-container] [Mod]

`MAX_PATH_FAILURES=5` counts consecutive matching-task `calc_failed` events (reset on `at_goal`) and fails early; fresh success postconditions take precedence and cleanup stops the task. Ore `mine`/`collect` jobs (any requested block id ending `_ore`) use `min(15 min,max(5 min,count×40 s))`; other acquisition jobs retain their 120-second budget. Any job fails with `stalled: no movement or inventory change for 45 s` when neither position progress of ≥1 block nor target-count change occurs for 45 seconds. The mod retains the same no-break types but makes list membership O(1), avoiding ~1,100-element linear scans at every path node. Status/failure lines remain in the game log, not the chat HUD. These changes do not grant own-block pathing permission. [Ctl-skills] [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java) [D-42, D-49, D-51]

The controller owns the per-ore height table in `oreHeight()`: coal 96, copper 48, iron 16, gold -16, redstone -58, diamond -58 and lapis 0; deepslate variants share the mineral. Emerald, nether gold/quartz, ancient debris and other ores use current block Y. A request is ore-only when every id ends `_ore` or is `minecraft:ancient_debris`; any non-ore request uses the loaded-chunk scan for real logs/sand/stone. For ore-only acquisition, if the player is more than 4 blocks above `oreY`, first run `qc.baritone.goto {x,y:oreY,z}` at current x/z, then `qc.baritone.mine {blocks,targetCount,y:oreY}`. The RPC's optional `y` is branch-mining height and defaults to current player block Y; the mod no longer owns a mineral table. Do not treat anti-xray hidden ore census matches as reachable real resources. [D-50, D-59] [Ctl-skills] [RPC contract](20-companion-mod.md)

Ore acquisition skips the nearby ore scan/block probe because Paper can fabricate hidden matches. Before Baritone starts, the controller selects the best inventory pickaxe and checks static harvest tier; insufficient tools fail with `need a <tier> pickaxe or better to mine <block>`. Existing natural-block protection still applies. Non-ore acquisition retains scan/protect/harvest preflight unchanged. The 45-second rule applies to shared Baritone jobs, not unrelated crafting/chat execution. [D-50, D-51, D-26] [Ctl-skills]

| Exact tool | Backing calls / implemented composition | Verified success condition; failure summary | Mindcraft precedent |
|---|---|---|---|
| `observe` | Observation builder: `player.getState`, `player.getInventory`, `player.getEquipment`, `player.getStatusEffects`, `session.info`, `perception.scan`, `perception.entities`, `qc.world.state`, `qc.control.state`, `qc.baritone.status`, `qc.placed.near` for `ownBlocksNearby`, `qc.inventory.tools` for damageable stacks. [M-player] [M-perception] [Mod] [D-09, D-49, D-61] | Fresh snapshot with unavailable fields explicit; `observation unavailable`. [D-09] | `!stats`, `!inventory`, `!nearbyBlocks`, `!entities`. [MC-query] |
| `look_screenshot` | `vision.screenshot`; attach returned PNG once to the next model turn. [M-vision] [D-22] | Nonempty decoded image with reported dimensions; `screenshot unavailable`. [D-22] | No direct equivalent in the inspected action registry. [MC-A1] [MC-A2] [MC-A3] [MC-A4] [MC-A5] [MC-A6] [MC-A7] |
| `go_to(x,y?,z,range?)` | `qc.baritone.goto` → `qc.task`/`qc.baritone.status`; read `player.getState`. y+range → GoalNear; y alone → GoalBlock; y omitted → GoalXZ and range ignored. [Mod] [B-goal] [B-near] [B-block] [B-xz] [M-player] [D-08] | Position satisfies requested goal; `path calculation failed`, `movement interrupted`, `home radius exceeded`. [D-20] [D-37] | `!goToCoordinates`. [MC-A2] |
| `go_to_player(name)` | `qc.baritone.follow{player:name}` resolves the loaded player name in the mod. Controller `vision.describeScene` supplies name/UUID correlation, joined to UUID-only `perception.entities`; poll and stop within 3 blocks. [Ctl-skills] [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java) [D-08, D-09] | Fresh correlated player position is within 3 blocks and follow stops; mod error `player_not_loaded`; controller rejects missing/ambiguous visible identity. [D-42] [Ctl-skills] | `!goToPlayer`. [MC-A2] |
| `follow_player(name)` | Same mod name resolution and scene-name/UUID correlation; bounded 30-second tracking through `qc.baritone.follow`. [Ctl-skills] [D-08, D-09] | At least two observations and either proximity or observed movement toward the same target; interval end/interruption/target loss stops follow. This establishes tracking, not indefinite following. [Ctl-skills] [D-20, D-42] | `!followPlayer`. [MC-A2] |
| `explore(x,z)` | `qc.baritone.explore`, `perception.scan`, `player.getState`, then `qc.baritone.stop` at the skill budget. [Mod] [B-explore] [M-perception] [M-player] [D-08] | Fresh observed terrain/position progress, not whole-world completion; `no exploration progress`, `home radius exceeded`. [D-19] [D-37] | `!searchForBlock`, `!searchForEntity` are search analogues, not equivalent exploration contracts. [MC-A3] |
| `collect(item,count)` | Map supported item to producing block IDs, preflight harvestability; for ore-only requests select controller `oreHeight()` and descend first if more than 4 blocks above it, then `qc.baritone.mine` with explicit `y` and `targetCount=initial inventory+count`; non-ore requests use loaded-chunk scanning; reread inventory. Finds resources itself; no `explore` first. [Ctl-skills] [Ctl-tools] [D-07, D-08, D-26, D-50, D-59] | Matching inventory increase ≥count; `resource not found`, `cannot harvest`, `protected block`, `mining failed`, or the D-51 stall failure. Local bench acquired 4 oak logs. [D-09, D-38, D-51] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04) | `!collectBlocks`. [MC-A5] |
| `mine(block,count)` | Resolve block/drop mapping and starting matching inventory; same controller-owned ore-height/descent sequence, then `qc.baritone.mine{blocks:[block],targetCount:…,y:oreY}` for ores, or non-ore loaded-chunk scan; task/status and inventory reread. Finds ore itself; no `explore` first. [Ctl-skills] [Ctl-tools] [Mod] [B-mine] [M-player] [D-08, D-50, D-59] | Intended drop inventory delta ≥count; inactivity alone is not success; `mining failed`, `drop mapping unsupported`, `protected block`, or the D-51 stall failure. [D-09, D-26, D-51] | `!collectBlocks`. [MC-A5] |
| `craft(item,count)` | `recipes.query`, resolve unlocked recipe/intermediates, reuse an own/remembered table or place a carried/crafted one for 3×3 recipes, `container.open/state`, `craft.place`, take result via `container.click`, reread inventory; pick up a newly placed table afterwards (§ station lifecycle below). [M-recipe] [M-container] [M-interact] [M-player] [D-07, D-62] | Desired output delta ≥count; report recipe batch surplus; `recipe not unlocked`, `ingredients missing`, `craft output unverified`; failed pick-up appends `; station left placed at x y z`. [D-09, D-62] | `!craftRecipe`; its quantity need not mean our output units. [MC-A5] |
| `smelt(item,count,fuel?)` | Reuse own/remembered furnace or place a carried/crafted one, `container.open/state`; inspect input/fuel/output slots, safe whole-stack `container.transfer` or counted `container.click`; poll, take output and leftovers, reread inventory, close; pick up a newly placed furnace only when all slots are empty. [M-container] [M-player] [D-07, D-62] | Desired output delta ≥count with actual input/fuel/output recorded; `fuel missing`, `furnace inaccessible`, `smelting timed out`; failed pick-up/nonempty furnace appends `; station left placed at x y z`. [D-09, D-62] | `!smeltItem`, `!clearFurnace`. [MC-A5] |
| `repair_tool(item,x,y,z)` | Integer coordinates; verify anvil/chipped anvil/damaged anvil. Read `qc.inventory.tools`, choose the most damaged matching stack, select first available `repairWith` material and `min(4,ceil(damage/floor(maxDamage/4)),materialCount)` units. Open anvil, move inputs to slots 0/1 with counted clicks; poll `qc.anvil.state` ≤3 s, check actual cost against XP, take slot 2 and close. Remember successful anvil once per position. [Ctl-skills] [Mod] [D-61] | Matching inventory item has lower damage and XP level drops; summary `Repaired <id>: <left before> -> <left after> durability for <cost> levels`; delta includes before/after/cost/material/units. Failures include `no anvil at that position`, `item is not damaged`, `no repair material (...)`, `anvil shows no result`, `too expensive` (cost ≥40), `need <cost> XP levels, have <xp>`; close on failure to return inputs. Gameplay checks pending. [D-09, D-61] | Harness-specific repair composition; no direct equivalent claimed. [D-61] |
| `place_block(item,x,y,z,face?)` | Select/swap held item, navigate within reach, `control.lookAt`, enable sneak and wait **150 ms** before `interact.placeBlock`, then `perception.blocks` at actual target; always close any screen afterwards. [Ctl-skills] [M-inventory] [M-control] [M-interact] [M-perception] [D-09] | Requested block ID observed at target plus inventory use; placement response alone insufficient; `out of reach`, `placement unverified`. [D-09] | `!placeHere`; internal `placeBlock` supports coordinates. [MC-A5] [MC-placement] |
| `break_block(x,y,z)` | Protect check (natural, free zone, or active agent's unchanged tracked placement via `qc.placed.near`), `perception.blocks{tool:true}`, tool selection, approach, `interact.breakBlock{mode:"survival"}`, reread, `interact.stopBreaking`. The mod rechecks actual block identity and removes tracking after successful destruction. [M-perception] [M-inventory] [M-interact] [Mod] [D-26, D-49] | Loaded target changed from original block to expected removed state; `protected block`, `cannot harvest`, `break unverified`. [D-09, D-26, D-49] | Internal `breakBlockAt`, not a direct `!` registry command. [MC-skills] |
| `equip(item,slot?)` | Resolve inventory stack and destination; `inventory.swapSlots`/`inventory.selectHotbar`, or menu `container.click` if required; `player.getEquipment`. [M-inventory] [M-container] [M-player] [D-09] | Requested hand/armor slot holds item; `item missing`, `slot unsupported`, `equip unverified`. [D-09] | `!equip`. [MC-A4] |
| `eat(item?)` | Select edible item, `control.startUsing`, poll food/usingItem and inventory, always `control.stopUsing`. [M-control] [M-player] [M-inventory] [D-09] [D-32] | Food increased or observed edible consumption; `no edible item`, `cannot eat`, `consumption unverified`. [D-09] | `!consume`. [MC-A4] |
| `attack(target)` | Resolve unique nearby entity UUID with `perception.entities`; approach using `qc.baritone.goto`, `interact.attackEntity`, observe health/continued presence under bounded combat interval. [M-perception] [M-interact] [Mod] [D-09] | Damage observed to the same target; absence alone is not proof of kill; `target ambiguous`, `out of reach`, `damage unverified`. [D-09] | `!attack`, `!attackPlayer`. [MC-A6] |
| `chest_deposit(x,y,z,item,count)` | Approach own/authorized chest, `container.open/state`; whole stack into an empty destination uses **two clicks** (pickup + place); partial counts retain counted right-clicks. Check source/destination deltas, resolve cursor stack on interruption, close. D-58 directs the model to its own chests only. [Ctl-skills] [M-container] [M-player] [Mod] [D-09, D-26, D-58] | Exact source decrease and destination increase; `chest inaccessible`, `insufficient items`, `transfer unverified`. [D-09] | `!putInChest`. [MC-A4] |
| `chest_withdraw(x,y,z,item,count)` | Same menu path and two-click whole-stack / counted-right-click partial-count logic; verify deltas and return cursor-held items on interruption before closing. [Ctl-skills] [M-container] [M-player] [D-09, D-26] | Exact source decrease and player increase; `insufficient items`, `inventory full`, `transfer unverified`. [D-09] | `!takeFromChest`, `!viewChest`. [MC-A4] |
| `drop(item,count)` | Select/swap matching stacks; use `interact.dropItem{wholeStack:false}` repeatedly for partial counts, or `inventory.dropSlot` for exact whole stacks; reread inventory. [M-interact] [M-inventory] [M-player] [D-09] | Exact decrease, with observed item entities as corroboration; `insufficient items`, `drop unverified`. [D-09] | `!discard`. [MC-A4] |
| `chat_say(text)` | Chat lane only, with at least one current-request `mustReply`/`followUps` entry → reply budget/redaction → `qc.chat.send{text}`; public reply text, not a slash-command. Absent from body tools, with explicit body rejection as a safety net. [Mod] [D-18, D-44, D-48, D-54, D-55] | `sent:true` confirms submission, not remote receipt; retain `chat is only for replying to a message that mentions you`, `rate_limited`, `too_long`. [D-18, D-47] | Conversation output is agent policy rather than this exact tool. [MC-output] |
| `chat_reply(to,text)` | Same chat-lane pending-entry gate, budget and redaction; whisper route uses `/msg <to> <text>` via `qc.chat.send`, otherwise public addressed response. Success restarts answered senders' and explicit recipient's five-minute windows. [Mod] [D-18, D-36, D-44, D-54, D-55] | `sent:true`; count formatted length; retain `chat is only for replying to a message that mentions you`, `recipient ambiguous`, `rate_limited`, `too_long`, `command_not_allowed`. [D-18, D-36, D-47] | `!startConversation`/agent output are analogues. [MC-A7] [MC-output] |
| `run_command(command)` | Validate first token against `commands.allowlist`, then `qc.chat.send`; never `command.run`. [Mod] [D-10] [D-29] [D-36] | Sent command plus applicable observable consequence (e.g. position for travel); submission-only explicitly stated if no outcome is observable; `command_not_allowed`, `command outcome unverified`. [D-09] [D-29] | No equivalent curated slash-command action claimed. [MC-A1] [MC-A2] [MC-A3] [MC-A4] [MC-A5] [MC-A6] [MC-A7] |
| `remember(kind,name,note,x?,y?,z?)` | Local validated `notes.json` write; current coordinates via `player.getState` when location needed. [M-player] [D-33] | Persisted note readback; `memory write failed`. [D-33] | `!rememberHere`. [MC-A3] |
| `recall(query)` | Local notes lookup; include server/dimension and observation age. [D-33] | Matching notes or explicit empty result; `memory read failed`. [D-33] | `!savedPlaces`, `!goToRememberedPlace`. [MC-query] [MC-A3] |
| `set_goal(text)` | Skill returns `observedDelta:{goal:text}`; the loop alone pushes it onto its in-memory goal stack and updates the HUD. [Ctl-skills] [Ctl-loop] [D-19, D-23] | Goal state changed, not achieved; no notes-owned duplicate stack. [D-19] | `!goal`. [MC-A6] |
| `finish_goal(summary)` | Skill returns verified/abandoned outcome data including `observedDelta.goalFinished`; the loop alone pops the current goal, restores its parent and clears the terminal instruction when the stack empties. [Ctl-skills] [Ctl-loop] [D-09, D-23] | Observed-outcome or explicit-abandonment check must pass before the loop mutates goal state; `goal outcome unverified` otherwise. [D-09] | `!endGoal`. [MC-A6] |
| `stop()` | Shared cleanup above, then verify `qc.baritone.status` and fresh player state; this cancels work but does not masquerade as operator `stop`/console pause. [Mod] [M-player] [D-11] [D-20] | Task inactive and no continuing synthetic action observed; `stop unverified`. [D-11] | `!stop`. [MC-A1] |
| `harness_info(question)` | `searchHarness` reads repository docs/controller/heuristic/mod source, excluding evidence; top-three snippets, ≤1,500 characters, repo-relative filenames, shared redaction. [Ctl-selfinfo] [Ctl-skills] [D-43, D-44, D-45] | Redacted lookup result or explicit no matches; no shell/code execution, no gameplay authority. [D-09, D-17, D-45] | Harness-specific Q&A, not a borrowed gameplay action. [D-45] |

### Portable station lifecycle

`Skill.station(id)` returns `{pos:Vec3,placedHere:boolean}`: reuse a nearby own/remembered station, otherwise place the carried station (craft it first if missing) and remember it as `"owned"`. Only a station placed by this call is picked up; existing stations are never broken. After success or failure, unless aborted, close the menu, break via guarded `break_block` logic, walk onto its position and verify station inventory count returns to the pre-placement value within 5 seconds. Furnaces must first be emptied of output and leftovers. Pick-up failure (including full inventory/uncollected item), nonempty furnace or abort leaves the station placed with its `"owned"` note and appends `; station left placed at x y z` to the result summary. **[VERIFY] Bench and RayCraft station lifecycle checks pending.** [D-62, D-49, D-26] [Ctl-skills] [Pending checks](50-install-and-verification.md#tool-durability-and-portable-stations--pending)

### Verified placement and chest-transfer fixes

`place_block` now waits **150 ms after enabling sneak** before clicking and always closes any screen afterwards. The orchestrator's bench had exposed the same-tick failure: clicking against a crafting table opened it instead of placing the carried block. [Ctl-skills] [D-09] [Bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

Whole-stack chest moves to an empty slot use pickup + place, not one right-click per item; counted right-clicks remain for partial counts. Bench checks used the server's own `data get block` and `clear … 0`: **21 of 21 transferred in 0.8 s** (previously ~4 s on the bench; ~21 s per stack observed on RayCraft), **10 of 21** left chest 10 / inventory 11, and an interrupted transfer returned all **21** cursor-held items to inventory. These are sampled timings and conservation checks, not a throughput guarantee. [Ctl-skills] [D-09, D-38] [bench/rcon.ts](../bench/rcon.ts) [Bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

The reported chest duplication was investigated and **NOT reproduced**. The RayCraft transcript's `chest_deposit` of 64 packed ice returned `inventoryDelta:-64` / `containerDelta:+64`: the agent held **85 (64+21)** and deposited one full stack, rather than duplicating 21 items. Server-checked normal, partial and interrupted bench runs conserved items; this does not prove every possible transfer state is safe. [Ctl-skills] [D-09, D-38] [Bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

### Implemented skills awaiting wider live proof

MCPFabric's documented runtime plans smelting steps but does not execute them automatically; unlocked recipes, client-local remote action verification, and whole-stack container transfers are documented limitations. [M-limits] [M-recipe] [M-container] [M-interact]

Furnace slot mapping, recipe/fuel resolution, progress windows, counted menu transfers and cursor cleanup are implemented in `skills.ts`; [VERIFY] prove their remote acknowledgement/postconditions on RayCraft. `container.transfer` alone cannot satisfy exact quantities; the skill uses counted clicks and source/destination inventory checks. [Ctl-skills] [D-07, D-09, D-38] [M-container] [M-limits]

Supported item/block/drop mappings and inventory-target translation are implemented in `skills.ts`; the local bench proved oak-log acquisition and planks/table/sticks/wooden-pickaxe crafting. [Ctl-skills] [D-09, D-50] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04) [VERIFY] Exercise remaining variants, legit iron progress at y=16, and the full D-38 crafting/smelting sequence on RayCraft. [D-38, D-50]

[VERIFY] Prove block-face/target semantics, equipment slot mapping, edible-item recognition, combat cooldown/damage observation, player proximity, and finite follow/exploration termination on RayCraft; the listed primitives do not establish those complete skills. [D-09] [D-38] [M-interact] [M-inventory]

Named-player correlation is implemented without extending `qc.task.detail`: `vision.describeScene` identifies name/UUID, and `perception.entities` supplies position for that UUID. The mod independently resolves the name for `qc.baritone.follow`. [Ctl-skills] [D-08, D-09, D-42] [VERIFY] Prove live approach/follow for a player who has never chatted, moving targets and unloaded/ambiguous identities on RayCraft. [D-38]

Protect/chat/allowlist/leading-`#` guards are designed as mixins on the client action path, covering raw MCPFabric and Baritone, not just `qc.*` dispatch; controller checks are additional defense. Set Baritone `chatControl=false` and `prefixControl=false`, because prefixed chat handling is independent. [D-10] [D-26] [D-29] [Mod] [B-chat]

Client action-path mixin targets are resolved in the companion: `MultiPlayerGameMode.startDestroyBlock`/`continueDestroyBlock`/`destroyBlock`, with D-49 tracking at `useItemOn` and removal on successful destruction, and `ClientPacketListener.sendChat`/`sendCommand`/`sendUnattendedCommand` plus delayed confirmation. [Mod] [D-10, D-11, D-25, D-26, D-49] [VERIFY] Complete live raw MCPFabric/Baritone/heuristic bypass, own-placement and pause matrix; the local protected-table/allowlist checks are not exhaustive path acceptance. [D-38]

`chat_reply(to,text)` requires a safely named recipient previously seen in a whisper; policy tracks these names, withholds unknown recipients and rejects redaction-changing recipients. Vanilla `/msg` replies worked on the bench. [Ctl-chat] [D-14, D-36, D-44] [VERIFY] Repeat against RayCraft's actual private-message formats. [D-38]

## 5. Observation schema

Build one compact, timestamped body-turn observation targeting 2–4k tokens; prioritize hazards, active goal/result, inventory and nearby resources, while retaining recent chat only as context. Mark omitted/truncated information rather than presenting it as absence. Pending conversation entries belong to the chat-lane input, not the body request. [D-09, D-15, D-33, D-55]

This field inventory defines the per-turn JSON exposed as `Observation = Record<string, unknown>`, not a new bridge schema; retain source IDs/coordinates/units and acquisition timestamps in the controller, even when the model sees an aggregated view. [D-09] [D-25]

| Observation field | Content / source | Basis |
|---|---|---|
| `session` | `session.info`: server/world identity, player and dimension. | [D-33] [M-perception] |
| `player` | `player.getState`: position/orientation, motion, health/maxHealth, food/saturation, air/maxAir, water/ground/item-use flags, selected slot and `xpLevel` for repair planning. | [D-09, D-61] [M-player] |
| `inventory` | Aggregated item counts plus necessary hotbar/armor/offhand slot details from `player.getInventory` and `player.getEquipment`; `freeSlots = 36 − listed hotbar+main stacks` because empty slots are omitted by `player.getInventory`. Armour/offhand do not consume those 36 slots. | [D-09, D-58] [M-player] [controller/observe.ts](../controller/observe.ts) |
| `tools` | `qc.inventory.tools`: damageable hotbar/main/armor/offhand stacks as `{slot,id,left,max,pct,enchanted,enchantments,repairWith,repairCost}`; `left=maxDamage-damage`, `max=maxDamage`, `pct=round(100*left/max)`, `enchanted=enchantments.length>0`. Sort by ascending pct; 1,500-character budget, truncation recorded. RPC failure marks `metadata.unavailable.tools`, not an empty healthy inventory. | [D-61] [Mod] [controller/observe.ts](../controller/observe.ts) |
| `effects` | `player.getStatusEffects`, with remaining ticks. | [D-09] [M-player] |
| `terrain` | `perception.scan`: loaded chunk surfaces/biomes/counts, nearby POIs and requested resource matches; `perception.blocks` for targeted checks. Scan radius is in chunks, not blocks. | [D-09] [M-perception-source] |
| `ownBlocksNearby` | Up to 32 nearest `[x,y,z,id]` tuples (`[number,number,number,string][]`) compacted from `qc.placed.near` block objects at current player coordinates with `radius:6` blocks; current server+dimension only, unchanged ids only. Null plus `metadata.unavailable.ownBlocksNearby` on unavailable RPC/player coordinates, not a false empty list. | [D-49] [Mod] [controller/observe.ts](../controller/observe.ts) |
| `entities` | `perception.entities`: UUID, type/kind, position, distance, health/item stack when supplied. | [D-09] [M-perception] |
| `timeWeather` | `qc.world.state{}` → `{dimension,dayTime,gameTime,raining,thundering}`, read from client level by the companion. | [D-09] [Mod] |
| `control`, `task` | `qc.control.state`, `qc.baritone.status`, last matching `qc.task`. | [D-11] [D-20] [Mod] |
| `goals`, `home`, `zones` | Controller goal stack and configuration: `/home`-derived home when initially null, overridden by `home set`; never derived from untrusted chat. | [D-05] [D-26] [D-31] [D-37] [D-40] |
| `recentChat` | Bounded `qc.chat` context preserving identity, addressing/self flags; includes non-addressed, system and history lines. Context alone never authorizes chat tools or wakes the body; the chat lane separately receives the last 30 events. | [D-14, D-48, D-55, D-56, D-57] [Mod] |
| `lastResult` | Last `{ok,summary,observedDelta}`, partial progress and cancellation included. | [D-09] [D-20] |
| `hints` | Ordered `onObservation` strings, advisory only. | [D-25] |

Voyager demonstrates compact status, inventory, voxel and chest observations, while Mindcraft combines stats/entities/nearby blocks in prompts; borrow their information categories, not their Mineflayer transport. [Voy-status] [Voy-voxels] [Voy-inventory] [Voy-chests] [MC-prompt] [D-01] [D-09]

Upstream `world.getTimeAndWeather` executes against a server level and its dispatcher rejects a missing local server, whereas client perception expressly distinguishes itself from server-only `world.*`; do not treat that method as a RayCraft remote-player read. [M-world] [M-world-dispatch] [M-perception-source]

The companion resolves 26.3 client accessors, including `getOverworldClockTime()` rather than removed `getDayTime`; the observation builder records acquisition timestamps, unavailable reads and omitted/truncated fields. It never substitutes server-only `world.*`. [Mod] [controller/observe.ts](../controller/observe.ts) [D-09, D-25]

## 6. Loop, cancellation and self-goals

Maintain two independent single-flight lanes, one shared current instruction/goal context and one gameplay skill owner. **Body lane:** wakes for console instructions, skill completion/failure, death/respawn, or immediate `continue` after a current/unpaused no-tool reply when instruction or effective home exists. Chat never wakes it; its user message keeps `recentChat` as context, with no pending reply list, and its tools exclude `chat_say`/`chat_reply`. The explicit rejection in `guarded` remains a safety net. [D-05, D-19, D-20, D-24, D-51, D-55]

1. Snapshot the current generation and control state; build observation and advisory hints. Paused state permits observation/status but no new controller body skill; Java reflexes remain active under `console`/`lease_expired` and disabled under `hotkey`/`manual_input`. [D-11] [D-25] [D-32]
2. Request the model with thinking only for a new console-instruction plan or failed-tool replan on that instruction; all other wakes run without thinking. Preserve terminal authority and untrusted chat separation. [D-05, D-17, D-21, D-46]
3. Reject a response whose generation changed; validate tools, apply `onPlanProposed` hooks, then revalidate rewritten arguments against the same hard guards. [D-09] [D-20] [D-25]
4. Execute one skill, track its task/menu/input ownership, wait for observations or bounded completion, and return actual deltas. Between calls recheck pause, generation, target validity and home policy. [D-09] [D-11] [D-20] [D-37]
5. Append body assistant/tool history and JSONL records, print model prose to the console only, then process body wakes. With an instruction or home, no-tool body replies immediately queue `continue`. With neither instruction nor home and no queued body wake, the body is `Idle`; conversation runs independently. [Ctl-loop] [D-23, D-33, D-51, D-55]

A `continue` wake after a no-tool reply adds `"nudge": "Your previous reply had no tool call. Choose the next action now, or call finish_goal."` to the user message. With home but no instruction, continuation pursues D-31 self-directed survival; no timed pause precedes it. Paused or obsolete turns cannot queue new action authority. [Ctl-loop] [D-20, D-31, D-51]

### Independent chat lane

`chatTurn()` runs whenever pending addressed entries exist and the loop is not paused, even while a body tool or body model request is in flight. `mustReply` contains fresh incoming non-self player messages with `mentionsMe=true`, plus whispers; `followUps` contains fresh non-self player/whisper messages from a sender with `now - lastReplyAt(sender) <= 300000`, matched case-insensitively. No name is needed in a follow-up. Self, system and history events never qualify. [D-54, D-55, D-56, D-57]

Each chat request starts with `[system,user]` and its own message list, never appended to body `history`. Reuse the body prompt's identity, safety and chat rules, adding the exact clause: “This is the conversation lane: your body keeps working on its task in parallel. Answer every mustReply entry. followUps are recent messages from players you are already talking to: reply if the message is directed at you, otherwise ignore it.” Tools are only `chat_say`, `chat_reply`, `harness_info`, `observe`; thinking is off, request timeout is 30 seconds, and a lane turn permits up to three tool rounds. No gameplay tools, goal changes or memory-written instructions are allowed. [D-55, D-17]

The user JSON is `{mustReply,followUps,recentChat,live}`. `recentChat` is the last 30 chat events as context; `live` contains `{goal,instruction,currentAction:skill,lastResult}` with images removed, plus position/health from a quick `player.getState`. Print each chat-lane reply through the existing console log. Pending entries are the only reply authority: `chat_say`/`chat_reply` require at least one `mustReply`/`followUps` in that request, otherwise return `chat is only for replying to a message that mentions you`. Recent context alone is insufficient. [D-55, D-47, D-44]

After successful `chat_say`/`chat_reply`, clear answered `unanswered` entries using the existing sender inference, set `lastReplyAt(sender)=now` for every answered sender (and explicit `chat_reply` `to`), and clear follow-up entries from those senders. Every successful reply restarts the window; the model may skip follow-up lines clearly not meant for it. When a turn finishes, run the lane again immediately if new pending entries arrived meanwhile. Any pause prevents chat-lane runs; addressed pending entries keep the existing 120-second expiry, and follow-ups expire with the five-minute window. `wake('chat history', event)` only appends context: no pending entries or lane runs. [D-54, D-55, D-57]

Orchestrator implementation amendment: unanswered `mustReply` entries retry after five seconds with a nudge, at most twice per entry, then log `Unanswered chat dropped: <sender>: <text>` instead of spinning indefinitely. Ignored `followUps` are consumed after the turn; their conversation window remains bounded by the last successful reply. Live heuristic reply decisions go through the model chat lane rather than sending directly. [D-55, D-54, D-25] [Ctl-loop] [Ctl-main]

### Body state and recovery

The loop owns the goal stack; skills communicate goal mutations only through successful `set_goal`/`finish_goal` `observedDelta` results. This is separate from remembered places and prevents skill/notes state from competing with loop authority. [Ctl-loop] [Ctl-skills] [D-09, D-19, D-20, D-33]

The loop updates `qc.hud.set` with `{goal?:string,action?:string,status?:string}` → `{ok:true}`; omitted fields are unchanged and an empty string clears a field. The four-line HUD is pause/active header, `Goal: <goal>`, `Action: <action>`, and `Status: <status>`. The mod appends ` (<N>s)` after status text has remained unchanged for at least 2 seconds, counting whole seconds since its last change and truncating lines to screen width. [Ctl-loop] [Mod](20-companion-mod.md#10-hud-and-session-lifecycle)

| Loop phase | Exact HUD status |
|---|---|
| Before a planning request with thinking off | `Waiting for Qwen` |
| Before a planning request with thinking on | `Qwen is thinking` |
| Before history compaction | `Summarizing memory` |
| While a tool runs | `Running <tool>` |
| No instruction, no home, and no queued wake | `Idle` (nothing to do) |
| LLM failure/backoff | `Qwen unreachable, retrying in <N>s` (N is seconds until `retryAt`) |
| Paused | `Paused: <reason>`; replaces stale `Running <tool> (Ns)` rather than keeping a canceled tool's running status. [Ctl-loop] [D-11, D-23] |

At tool start, action is `<tool> <compact args>`, with arguments serialized as compact JSON and truncated to 60 characters. At completion, action is `<tool>: done, <summary>` or `<tool>: failed, <summary>`, truncated to 120 characters. Preserve this factual tool activity instead of overwriting it with model prose. [Ctl-loop] [D-23]

A new free-text console instruction increments generation immediately, aborts inference/skill waits, performs shared stop cleanup, observes settled state, then replans; an old response/task event cannot start or finish the replacement goal. Mindcraft's action manager is a cancellation precedent, not the selected chat-authority policy. [D-05] [D-20] [MC-manager]

Incoming mentions, whispers and eligible conversation follow-ups run in the separate chat lane while the body retains its console/self-survival goal. There is no wait for a body-tool boundary and no chat mode inside a body turn. Chat cannot smuggle movement, commands, goal changes or memory instructions into either execution batch. System lines and history remain context only. [D-48, D-54, D-55, D-56, D-57, D-17, D-20]

`qc.task` reports only `at_goal`, `calc_failed`, `canceled`, or `lost_control`; none is a final success flag. Reconcile the matching task/status and fresh position/inventory postcondition before the controller alone declares `done`/`failed`; record cancellation/partial progress rather than completing an obsolete generation. A calculation failure may leave mining retrying, and loss of control can accompany normal arrival, so signals must be interpreted with lifecycle state and observations; inactivity alone is not success, and `isPathing()` can be false while paused. [D-08] [D-09] [D-20] [D-42] [B-events] [B-mine] [B-lifecycle] [B-path]

On LLM timeout/error, an already-running deterministic, guarded skill may finish, but no new skill starts; suspend idle self-goal steps, preserve the last tool action, set HUD status to `Qwen unreachable, retrying in <N>s` (N is seconds until `retryAt`), and retry after 5/15/60 seconds, then every 60 seconds. Console, lease heartbeat and normal mod guards/reflexes continue; successful inference must still pass the current generation and pause checks. Compaction failures also log their error message through `deps.log`. [Ctl-loop] [D-11] [D-19] [D-20] [D-23] [D-32]

Hermes also uses Spark-local `http://127.0.0.1:8000/v1`; the endpoint is shared rather than reserved to Minecraft. [Hermes-evidence]

Finite budgets include 200 ms TypeScript tick snapshots, 60-second coordinate travel, 30-second follow/explore intervals, and D-51's 5–15-minute count-scaled ore deadline with 45-second no-progress failure. Skill observation/completion waits honor cancellation; action-free turns immediately continue when an instruction or home exists. [Ctl-loop] [Ctl-skills] [D-19, D-20, D-51] [VERIFY] Exercise stall/timeout/cancellation behavior on RayCraft. [D-38]

Without a console instruction but with home set, immediately continue tools → food → iron → shelter/bed near `home`, without blueprint/house architecture in phase 1. The operator already ran `/sethome` on RayCraft: when `home=null`, activation sends allowlisted `/home` once, observes arrival, captures player position/session dimension, persists `home`, and prints it. Console `home set` overrides the anchor; do not adopt first spawn or repeatedly resend `/home`. [D-00, D-19, D-29, D-31, D-40, D-51] [M-player] [Mod]

Effective home is `notes.home ?? config.home`; `/home` is attempted only when both are unset. Arrival requires a dimension change or >1-block position change followed 500 ms later by a stable snapshot (≤0.25-block movement, same dimension), within a 10-second deadline. Unknown/denied commands or no arrival print ``set home with `home set` `` and leave home-dependent self-direction idle. The vanilla bench exercised that fallback, not RayCraft teleport success. [Ctl-main] [D-31, D-40] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

With a configured home, enforce the controller's radius policy on `go_to`, `explore`, `go_to_player`, `follow_player`, and nested travel: use horizontal distance `sqrt((x-home.x)^2 + (z-home.z)^2)`, ignoring y. Reject targets beyond `selfGoal.radius` before dispatch, poll position during jobs, and stop when that same horizontal distance exceeds radius + 16 (272 blocks at the default). Moving-player targets also need the check as their positions change. Operator instructions do not silently redefine home. [D-31] [D-37] [D-39]

Phase 1 does not fence Baritone's paths; endpoint rejection and position polling can detect an excursion only after it occurs, and no mod path-radius RPC is implied. [D-08] [D-37] [Mod]

[VERIFY] Confirm cross-dimension behavior and polling/cancellation latency; demonstrate horizontal target rejection and the radius+16 stop, without asserting paths remain wholly inside the radius. Also prove bounded `/home` arrival detection (including delayed/denied/no-movement travel and cancellation), so sending the command alone never records an unverified home. The x/z metric and `/home` source are settled rulings, not open design choices. [D-08] [D-09] [D-37] [D-39] [D-40]

## 7. Heuristics

Load default exports from `heuristics/*.ts`; run higher `priority` first, ties by filename, with no blocking I/O in `onTick` (approximately 5–10 Hz). Hooks supply hints, rewrite/veto proposals, offer intents, or decide conversational routing; Java's 20-Hz core remains responsible for immediate survival. [D-25] [D-32]

The following interface and payload types are binding; `Observation` is the JSON field inventory in §5, and `ReflexIntent` is dispatched as a preempting curated tool call through every guard. [D-09] [D-25] [D-32]

```ts
type Vec3 = [number, number, number];
type Observation = Record<string, unknown>;   // the per-turn observation JSON defined in 30-controller.md
interface Ctx { config: Readonly<Record<string, unknown>>; notes: Readonly<Record<string, unknown>>; log(msg: string): void; now(): number; }
interface ToolCall { name: string; args: Record<string, unknown>; }
interface TickSnapshot { health: number; food: number; pos: Vec3; hostilesNear: number; paused: boolean; }
interface ReflexIntent { call: ToolCall; reason: string; }   // executed as a preempting tool call, through all guards
interface ChatEvent { id: number; kind: "player" | "system" | "whisper"; senderUuid: string | null; senderName: string | null; text: string; signed: boolean; mentionsMe: boolean; self: boolean; }
type ChatDecision = { reply: string } | { ignore: true } | { toModel: true };

export interface Heuristic {
  name: string;
  priority?: number;                       // higher runs first; ties by filename
  onObservation?(obs: Observation, ctx: Ctx): string[] | void;            // hints appended to the turn
  onPlanProposed?(call: ToolCall, obs: Observation, ctx: Ctx): ToolCall | { veto: string } | void;
  onTick?(snap: TickSnapshot, ctx: Ctx): ReflexIntent | void;            // ~5–10 Hz, must be non-blocking
  onChat?(msg: ChatEvent, ctx: Ctx): ChatDecision | void;                // {reply:string}|{ignore:true}|{toModel:true}
}
```

Filesystem watching triggers a 200 ms debounced, cache-busted file-URL TypeScript import; failed loads retain the prior successful version, throwing hooks disable that plugin until a file change, and removals unload it. Node 24 executes erasable `.ts` directly, with explicit `.ts` imports; the bench exercised veto and hot reload without restart. [controller/heuristics.ts](../controller/heuristics.ts) [controller/package.json](../controller/package.json) [heuristics/README.md](../heuristics/README.md) [D-04, D-25] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

Treat heuristics as trusted operator code, not a sandbox for model-written code; expose only the guarded context/intent path, never the bearer token or a raw bridge client. Their outputs still pass generation, pause, protect, command and chat-limit validation. [D-10] [D-11] [D-25]

Shipped `heuristics/inventory-chests.ts` (priority 50) reacts to `inventory.freeSlots <= 4`: deposit surplus bulk blocks into own nearby tracked chests or remembered `kind:"chest"` places; otherwise craft/place/remember a chest, first placing a carried block when no slots are free. It keeps tools/food/current-goal materials, never recommends other players' chests, and vetoes `drop` unless goal text contains whole-word `drop` (case-insensitive) for an explicit operator request. `LOW_FREE_SLOTS` and `BULK` are local tuning points; this is advisory storage policy plus a proposal veto, not general ownership detection. [D-58, D-25, D-49] [heuristics/inventory-chests.ts](../heuristics/inventory-chests.ts) [controller/test/inventory-heuristic.test.ts](../controller/test/inventory-heuristic.test.ts) [Authoring guide](../heuristics/README.md)

Shipped `heuristics/tool-durability.ts` (priority 40) checks `tools` each observation: low is `pct <= 25 || left <= 15`, critical is `pct <= 10 || left <= 5`; at most four urgent hints. Enchanted or diamond/netherite items with `repairWith` get `REPAIR` guidance for an own/remembered anvil, materials (up to four units) and XP estimate `units + repairCost`, followed by `repair_tool`; no anvil means craft one near home for 31 iron ingots. Short XP advises mining/smelting/mobs; critical repair advice stops use/switches tools. Others get pre-emptive `REPLACE` guidance, immediate when critical. No low tools means no hint. Actual anvil cost is authoritative, not the estimate. [D-61] [heuristics/tool-durability.ts](../heuristics/tool-durability.ts)

Shipped `heuristics/station-kit.ts` (priority 45) reserves one crafting table and one furnace via tunable `KEEP`; missing-kit hints name 4 planks / 8 cobblestone and automatic place/use/pick-up. It vetoes `chest_deposit` and `drop` when requested quantities would leave fewer than `KEEP`, with `<id> is reserved (station-kit heuristic): keep <n> in the inventory`. D-58's keep list includes both stations; reserve counts do not fix their slot indices. **[VERIFY] Bench and RayCraft durability planning, reserve vetoes and station pick-up remain pending.** [D-62, D-58, D-25] [heuristics/station-kit.ts](../heuristics/station-kit.ts) [Pending checks](50-install-and-verification.md#tool-durability-and-portable-stations--pending)

Example `heuristics/survival-hint.ts` is a five-line default export; its reload changes the next observation hint, not the hard safety rules. [D-25] [D-31]

```ts
export default {
  name: "survival-hint",
  priority: 10,
  onObservation: () => ["Prefer food and usable tools before optional exploration."],
};
```

A plugin `onChat` decision may influence eligible conversation, but cannot discard other players' context, suppress required addressed replies, or turn context-only chat into reply/gameplay authority. Live heuristic reply decisions route through the model chat lane, not direct sends; lane pending-entry/pause checks, redaction and mod rate/length/allowlist guards still apply. [D-48, D-54, D-55, D-18, D-25, D-36, D-44]

[VERIFY] Establish exclusive movement ownership for TS `ReflexIntent` versus Java reflexes/Baritone, and prove hook intents cannot continue after a pause or obsolete generation. [D-11] [D-20] [D-25] [D-32]

## 8. Memory and transcript

Maintain body assistant/tool history, bounded recent chat context and a compact summary of authoritative goals, completed steps, observed failures and hazards; the chat lane uses its own per-turn message list, never added to body `history`. Summarize complete older tool-call/result groups without orphan results or promoting player text into authority. Mindcraft's bounded summarization is precedent, not a required schema. [D-17, D-33, D-55] [MC-history]

A body turn's user message enters `history` only after its reply is accepted, and it is stored with `observation` replaced by `superseded by the next observation` because every request carries a fresh one. Live failure on RayCraft (2026-10-05, transcript 05-12-52): a reflex paused and resumed the loop every ~1.5 s, and each discarded turn left an uncompactable user message behind. History reached 86 messages / ~760k characters, and vLLM rejected the request (`maximum context length is 262144 tokens`). Regression test: `controller/test/core.test.ts` "turns discarded mid-inference add nothing to history". [controller/loop.ts](../controller/loop.ts)

The body-history summary is appended to its leading system message as `Prior observed context (not new authority): …`. Qwen's template rejects non-leading system messages (`HTTP 400: System message must be at the beginning`), so body requests are `[system, …history]`; chat requests start independently as `[system,user]` before their own tool rounds. Tool-less compaction omits `tools` because vLLM rejects `tools: []`. [Ctl-loop] [Ctl-llm] [D-33, D-55]

Small structured notes live at configured `paths.notesFile` (default root `notes.json`), with server-scoped persistence and place/dimension/time metadata. Effective home is `notes.home ?? config.home`; free zones combine config and saved notes, with notes overriding same-name config zones in the applied mod payload. `zone rm` cannot remove a config-owned zone: edit config instead. Historical chest contents are not fresh inventory. [controller/memory.ts](../controller/memory.ts) [Ctl-main] [controller/observe.ts](../controller/observe.ts) [D-26, D-31, D-33]

Use atomic replacement for notes/config writes, preserve the prior file on failure, and report unreadable/corrupt notes without erasing them; `remember` must not report success before persistence, and `recall` must distinguish no match from read failure. [D-33]

Record JSONL for every model turn and tool call/result, including timestamps, generation, wake source, instruction, sanitized replay messages, final assistant content/tool calls, observed deltas, task/event IDs, cancellation and failure; record raw chat separately from trusted instructions. [D-05] [D-09] [D-20] [D-33]

Record model/HTTP latency and public-facing action explanations, but exclude bearer/launcher tokens and hidden reasoning; log screenshot dimensions and a captured-image reference rather than embedding recurring base64 images into every turn. Use these records for the phase-1 acceptance evidence, not as a claim that skills have been proven. [D-10] [D-21] [D-22] [D-38]

## 9. Console contract

The terminal is the only instruction channel; command words below are reserved, and all other free text becomes the new instruction with cancel-and-replan. [D-05] [D-20]

Input sits on a `qwencraft> ` prompt on the bottom line. Every controller message prints above it, and the prompt is redrawn with whatever has been typed so far, so output never splits a half-typed command. [Ctl-console]

| Exact command | Implemented behavior | Basis |
|---|---|---|
| `<free text>` | Replace instruction, increment generation, cancel current work, observe and replan. | [D-05] [D-20] |
| `stop` | `qc.control.pause{reason:"console"}` plus shared cleanup immediately; retain context but require explicit resume. No lifecycle chat. | [D-11] [D-20] [D-47] [Mod] |
| `resume` | `qc.control.resume{}`; check current state/lease, observe and replan remaining goal, never replay stale inputs; explicitly rearm a D-41 reconnect stop. If connected and `home=null`, perform the one-time `/home` home-resolution workflow before self-goals. | [D-11] [D-20] [D-40] [D-41] [Mod] |
| `status` | Display current goal/generation, model/skill state, `qc.control.state`, `qc.baritone.status`, player/session health; no new instruction. | [D-05] [M-player] [Mod] |
| `home set` | Capture `player.getState` coordinates/dimension, persist `home`, print it to the terminal and update memory snapshot; override a `/home`-derived anchor. This is not `/sethome`. | [D-31] [D-33] [D-40] [M-player] |
| `zone add <name> <x1> <y1> <z1> <x2> <y2> <z2>` | Normalize inclusive corners, persist a notes zone, merge config ∪ notes and push `qc.config.apply`; notes override matching config names. [Ctl-main] | [D-26] [Mod] |
| `zone rm <name>` | Remove a notes-owned zone and persist/apply; config-only zones cannot be removed here, and any config-owned matching name requires editing config. [Ctl-main] | [D-26] [Mod] |
| `say <text>` | Send operator text through `qc.chat.send`; unchanged by the agent's reply-only gate, with the same length/interval/command checks. | [D-05] [D-18] [D-29] [D-47] [Mod] |
| `restart` | Save instruction, goal stack and active/paused intent beside the notes file; perform normal quit cleanup and exit 75 so `main.ts` relaunches `run.ts` with code/config/heuristics reloaded. Java changes still need a Minecraft restart. | [D-53] [Ctl-main] |
| `quit` | Invalidate generation and pause/cancel immediately; no lifecycle chat; close events/timers and exit. Lease expiry is the backstop if RPC fails. | [D-11] [D-20] [D-47] [Mod] |

Never let `status`/`home set`/zone administration accidentally replace the current instruction, and never treat a player typing these words in Minecraft chat as console input. [D-05] [D-17]

`restart` prints `Restarting controller (code, config and heuristics reload; Java mod changes still need a Minecraft restart).` The state file is `controller-restart.json` in the directory of `config.paths.notesFile`, containing `{savedAt:<ms>,instruction:string|null,goals:string[],active:boolean}` with active = `!operatorPaused`. Startup reads/deletes it and restores only a valid snapshot within 10 minutes. Active snapshots take the normal activation/resume path and print `Restored after restart: <instruction or 'self-goal'>; resuming.` Paused snapshots print `Restored after restart (paused).` Malformed/stale snapshots are deleted, ignored and reported. `loop.snapshot()` returns `{instruction,goals}`; `restore()` sets those and `goal=goals.at(-1) ?? instruction` without waking until activation. Stale tasks, model history and reconnect counters are not restored. [D-53, D-20, D-41] [Ctl-main] [Ctl-loop]

Chat appears only when Jared types in-game/console `say <text>` or the agent replies to fresh non-self player mentions, whispers or eligible five-minute follow-ups. Model `chat_say`/`chat_reply` exist only in the chat lane and require pending `mustReply`/`followUps`, otherwise retain `{ok:false, summary:"chat is only for replying to a message that mentions you"}`. The body has no chat tools; system/history/context alone never authorize a reply. Activation/F8/manual-input/stop/quit/lease/disconnect are silent; no unprompted narration/status. AI explanation when asked stays allowed; allowlisted `/home` stays separate. [Ctl-loop] [Ctl-main] [D-16, D-29, D-47, D-48, D-54, D-55, D-56, D-57]

For self-Q&A, reuse `ABOUT_ME` and permit `harness_info` alongside `observe` and the two chat tools in the independent chat lane. Answers may explain model/architecture, safety, requested code details and observed goal/results/latency. Every outgoing policy line is code-redacted before splitting; console/command sends share the redactor. Network details, credentials and local paths stay withheld, not game coordinates or repo-relative filenames. [Ctl-selfinfo] [Ctl-loop] [Ctl-chat] [Ctl-main] [Ctl-skills] [D-43, D-44, D-45, D-55]

## 10. Death, reconnect and resumption

On `qc.death`, invalidate the old generation, cancel skill state, save death position/context, and call `qc.session.respawn{}` only if not operator-paused; an `{ok:true}` response is followed by fresh player/inventory/task observations before a thinking replan. Never assume lost inventory remains held or replay the old tool batch. [D-11] [D-20] [D-21] [D-24] [Mod]

On `qc.disconnect`, invalidate work, stop lease/body assumptions, and inspect the reason case-insensitively against `reconnect.stopPatterns=["ban","banned","kicked by"]`; any match suppresses automatic reconnect and reports to the terminal. Do not use the LLM to override a ban/staff-kick stop. [D-24] [D-34]

For other reasons, permit at most three automatic reconnects through `qc.session.connect{host:server.host,port:server.port}` after delays 30000, 120000, 600000 ms. Retain `reconnect.maxPerHour=3`, but the counter is not a rolling-hour window: reset only after 1 hour continuously connected without a disconnect, not immediately on a successful join. The 4th disconnect before reset stops the agent until console `resume`; do not keep retrying merely because an hour passed while disconnected. Count dispatched attempts, including failed joins, toward the bound [INFERENCE: conservative attempt accounting]. [D-24] [D-34] [D-41] [Mod]

The D-41 counter, latch and stable-connection timer are in-memory process state only; restarting the controller resets that accounting. No reconnect counter is persisted in notes. [Ctl-main] [D-41]

A `qc.join` is evidence to reconcile state, not authorization to drive: verify intended server, reapply config, renew lease, inspect pause reason, observe session/player/inventory, start the stable-connection timer, then replan only if the operator has not paused. Cancel stale reconnect timers on `stop`/`quit` and stop the stability timer on disconnect. [D-11] [D-20] [D-24] [D-34] [D-41]

[VERIFY] Prove pause precedence through death/rejoin, duplicate lifecycle events, disconnect UI transitions and failed connects on RayCraft; successful player observations close the respawn workflow because there is no separate respawn-success event. Demonstrate the D-41 fourth-disconnect latch and full one-hour stable reset, including `resume` while disconnected; process-restart accounting is the in-memory limitation above, not an unresolved persistence design. [D-11, D-24, D-34, D-38, D-41] [Ctl-main]

The mod-side `qc.session.*` integration and stop/input release require the build checks in [20-companion-mod.md](20-companion-mod.md) and all RayCraft procedures in [50-install-and-verification.md](50-install-and-verification.md); no controller acceptance is implied by this document alone. [D-24] [D-38]

## Source anchors

Upstream links below are commit-pinned; built `qc.*` and controller behavior cite sibling documentation or repo-relative source, not an assertion that upstream supplies the harness. [D-07, D-08]

[M-layout]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/docs/AGENT.md#L18-L36
[M-http]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/HttpBridgeServer.java#L23-L219
[M-config]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/config/McpConfig.java#L13-L76
[M-info]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/handlers/InfoHandlers.java#L14-L65
[M-events]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/events/EventBus.java#L18-L70
[M-sse]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/SseHub.java#L37-L59
[M-chat]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/handlers/ChatHandlers.java#L23-L53
[M-dispatch]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/MainThread.java#L24-L64
[M-player]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/LocalPlayerHandlers.java#L19-L149
[M-perception]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/PerceptionHandlers.java#L82-L330
[M-perception-source]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/PerceptionHandlers.java#L49-L330
[M-control]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/ControlHandlers.java#L16-L90
[M-interact]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/InteractHandlers.java#L54-L290
[M-inventory]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/InventoryHandlers.java#L19-L82
[M-vision]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/VisionHandlers.java#L42-L182
[M-nav]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/NavHandlers.java#L23-L63
[M-container]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/ContainerHandlers.java#L38-L152
[M-recipe]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/RecipeHandlers.java#L54-L171
[M-limits]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/docs/AGENT.md#L76-L108
[M-world]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/handlers/WorldHandlers.java#L165-L177
[B-goal]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/ICustomGoalProcess.java#L46-L54
[B-mine]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/process/MineProcess.java#L70-L100
[B-follow]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IFollowProcess.java#L30-L58
[B-explore]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IExploreProcess.java#L22-L27
[B-events]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/event/events/PathEvent.java#L20-L33
[B-lifecycle]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/process/CustomGoalProcess.java#L98-L134
[MC-A1]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js#L27-L89
[MC-A2]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js#L90-L124
[MC-A3]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js#L125-L181
[MC-A4]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js#L182-L256
[MC-A5]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js#L255-L309
[MC-A6]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js#L308-L397
[MC-A7]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js#L398-L502
[MC-query]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/queries.js#L13-L226
[MC-skills]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/library/skills.js#L531-L608
[MC-placement]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/library/skills.js#L606-L621
[MC-prompt]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/models/prompter.js#L140-L170
[MC-manager]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/action_manager.js#L26-L112
[MC-output]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/agent.js#L414-L439
[MC-history]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/history.js#L19-L95
[Voy-status]: https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/env/mineflayer/lib/observation/status.js#L9-L101
[Voy-voxels]: https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/env/mineflayer/lib/observation/voxels.js#L10-L56
[Voy-inventory]: https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/env/mineflayer/lib/observation/inventory.js#L9-L35
[Voy-chests]: https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/env/mineflayer/lib/observation/chests.js#L3-L27
[V-parser]: https://github.com/vllm-project/vllm/blob/ced6857afa0ea7b2e3f0846a62e1394e90f15607/vllm/parser/qwen3.py#L179-L206
[LLM-probe]: evidence/vllm-capability-probe.json.txt
[LLM-template]: evidence/vllm-chat-template.jinja.txt
[tower-evidence]: evidence/tower-toolchain.txt
[server-evidence]: evidence/client-latest-log-connect.txt
[Mod]: 20-companion-mod.md
[B-near]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalNear.java#L35-L54
[B-block]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalBlock.java#L49-L66
[B-xz]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalXZ.java#L52-L65
[B-chat]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/command/ExampleBaritoneControl.java#L62-L75
[B-path]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/behavior/IPathingBehavior.java#L74-L105
[Hermes-evidence]: evidence/hermes-endpoint-config.txt
[M-envelope]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/Json.java#L30-L47
[M-event-json]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/events/GameEvent.java#L6-L14
[M-world-dispatch]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/handlers/WorldHandlers.java#L365-L369

[Ctl-main]: ../controller/run.ts
[Ctl-loop]: ../controller/loop.ts
[Ctl-skills]: ../controller/skills.ts
[Ctl-tools]: ../controller/tools.ts
[Ctl-chat]: ../controller/chat-policy.ts
[Ctl-selfinfo]: ../controller/selfinfo.ts
[Ctl-events]: ../controller/events.ts
[Ctl-llm]: ../controller/llm.ts
[Ctl-console]: ../controller/console.ts
