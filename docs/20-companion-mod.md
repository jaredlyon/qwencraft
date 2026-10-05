# Phase 1 — companion mod

**Status:** phase-1 companion implemented and exercised on the local bench; live RayCraft acceptance remains pending. House/blueprint architecture is deferred. [D-00, D-01, D-38] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

**Related:** [architecture](10-architecture.md), [controller](30-controller.md), [chat and safety](40-chat-and-safety.md), [installation and verification](50-install-and-verification.md), [decisions](00-decisions.md), [references](references.md). [D-00]

## 1. Purpose and boundary

The client-side `qwencraft` mod adds the following harness responsibilities rather than replacing MCPFabric's existing observation, inventory, interaction, and vision surface. [D-01, D-07, D-08]

| Responsibility | Existing evidence and harness addition |
|---|---|
| Terrain navigation | MCPFabric documents no swimming, ladders, pillaring, or tunnelling in its walker; use Baritone typed processes for harness navigation. [MCPFabric limits][M-limits] [D-08] |
| Identity-rich chat | MCPFabric's Fabric callbacks receive but discard `signedMessage` and export only sender name/text; capture the richer Fabric callback directly. [callback][M-chat-hook], [client export][M-chat-events] [D-14] |
| Operator control | Add F8, physical-input takeover, console pause, and dead-man lease around existing stop primitives. [stop primitive][M-control] [D-11, D-35] |
| Immediate survival | Existing sustained-use and attack primitives are not the harness's autonomous survival policy; put eat/escape/fight-back reflexes in Java. [use primitive][M-control], [interaction surface][M-interact] [D-32] |
| Hard guards | Add natural-block/zone/own-placement checks, chat limits, and command allowlist at agent execution boundaries, not merely in model prompts. [D-10, D-18, D-26, D-49, D-29, D-36] |
| Watch and recovery | Add client HUD, death/join/disconnect observations, respawn, and bounded reconnect primitives. [D-23, D-24, D-34] |

The tower controller remains the sole bridge client, the terminal remains the only instruction channel, and player chat is conversation rather than permission to act. [D-03, D-05, D-07, D-17]

## 2. Build baseline and dependencies

Use the official 26.3 example's non-remapping build baseline, adapting its project identity to `qwencraft`; do not copy an older mappings-based build. [example build][F-build] [D-06, D-13]

| Item | Selected baseline and evidence |
|---|---|
| Minecraft / loader | `26.3` / `0.19.5`. [example properties][F-props] [D-01, D-13] |
| Fabric API | `0.161.0+26.3`. [example properties][F-props] [D-01] |
| Loom | `1.18-SNAPSHOT`; plugin id `net.fabricmc.fabric-loom`. [properties][F-props], [build][F-build] [D-13] |
| Sources / dependencies | The built companion uses `src/main/java` only, ordinary `implementation` for loader/API and local vendor JARs, and no mappings dependency; unlike the example it does not split environment source sets. [mod/build.gradle](../mod/build.gradle) [D-13] |
| Java / Gradle | Java release/source/target `25`; wrapper `9.7.1-bin`. [build][F-build], [wrapper][F-wrapper] [D-13] |
| Mod environment | Client-only companion with mandatory `fabricloader`, `fabric-api`, `minecraft:~26.3`, `java:>=25`, `mcpfabric`, and `baritone` dependencies. [dependency semantics][F-deps] [D-01, D-08] |
| MCPFabric | Runtime release `0.5.0+26.3`; its loader id is `mcpfabric`. [release metadata][M-release], [mod metadata][M-mod] [D-01, D-07] |
| Baritone | Separate `baritone-api-fabric-1.20.0.jar`; API distribution retains public API names, unlike standalone. [setup][B-setup] [D-08] |
| Baritone loader identity | `baritone`; published source declares loader `>=0.19.5` and Minecraft `~26.3`. [metadata][B-mod] [D-08] |
| Baritone integrity | SHA-256 `49adfc063cfbfd0b6f08e9d814359807baa2d1768c0d39d6c5968268547cbca6`. [release assets][B-assets] [D-08] |

**V01 — Dependencies resolved.** Compile dependencies use `implementation files(...)` for pinned `vendor/mcpfabric-0.5.0+26.3.jar` and `vendor/baritone-api-fabric-1.20.0.jar`; runtime mods remain separate. Checksums are recorded in `vendor/SHA256SUMS`. No published Baritone Maven coordinate is assumed. [mod/build.gradle](../mod/build.gradle) [vendor/SHA256SUMS](../vendor/SHA256SUMS) [D-07, D-08, D-13]

[VERIFY] **V02 — Toolchain reproducibility.** Record the resolved Loom snapshot and compiler/wrapper versions during bring-up; `1.18-SNAPSHOT` names the selected baseline, not an immutable artifact hash. [example properties][F-props] [D-13]

Keep Baritone replaceable as a separate jar and preserve applicable notices/license copies when redistributing it; its metadata declares LGPL-3.0, whereas MCPFabric's license is MIT. [Baritone metadata][B-mod], [Baritone license][B-license], [MCPFabric license][M-license] [D-07, D-08]

## 3. Initialization, threading, and transport

1. Initialize client state and guards, acquire `BaritoneAPI.getProvider().getPrimaryBaritone()`, and use that game-created local player's process APIs. [API][B-api], [provider][B-provider] [D-01, D-08, D-10]
2. Register every method below via `McpFabric.router().register(method, handler)` after MCPFabric core initialization; the public router/event accessors expose the shared bridge objects. [accessors][M-access], [registry][M-router] [D-07]
3. Emit the event table through `McpFabric.events().emit(type, data)`; the bus assigns ids, retains 2,000 events, and fans out to SSE. [event bus][M-bus] [D-07, D-14]
4. Marshal client mutation onto the Minecraft executor, following MCPFabric's `ClientMc.call`/`MainThread` pattern; do not run model or blocking network work in client callbacks. [client dispatch][M-dispatch], [main-thread dispatch][M-thread] [D-03, D-07]
5. Register Baritone path listeners, Fabric chat/connection/tick callbacks, and HUD/keybinding integration; keep one harness-owned movement task. [Baritone bus][B-bus], [listener][B-listener], [Fabric tick][F-tick], [Fabric connection][F-connect] [D-08, D-11, D-23, D-32]

**V03 — Initialization resolved.** Client entrypoints run before the client loop: do not enqueue main-thread work and wait for it during init. `Qc.onMain` runs inline when already on the client thread, otherwise delegates to `ClientMc.call`; client registration initializes Baritone, guards and control once. Vanilla options/key mappings are captured at `ClientLifecycleEvents.CLIENT_STARTED`, not in the entrypoint. [mod/src/main/java/dev/qwencraft/Qc.java](../mod/src/main/java/dev/qwencraft/Qc.java) [mod/src/main/java/dev/qwencraft/QwencraftClient.java](../mod/src/main/java/dev/qwencraft/QwencraftClient.java) [Qc-control] [D-07, D-10, D-11]

The controller sends POST `/rpc` with `{method,params}` and receives `{ok:true,result}` or `{ok:false,error:{code,message,data?}}`; events use `/events` SSE plus `events.getRecent` with `sinceId` for bounded catch-up. [HTTP bridge][M-http], [RPC dispatcher][M-router], [poll handler][M-poll], [event bus][M-bus] [D-07]

[INFERENCE] Treat catch-up as bounded recovery, not a durable queue: the ring evicts old events and `recent` takes the newest matching entries up to its limit; reconcile task/player state when the cursor cannot cover the gap. [event bus][M-bus] [D-07, D-20]

## 4. RPC contract

All params/results below describe the implemented companion interface; `started` means accepted, not completed, and no row creates a second LLM-facing tool API. MCPFabric's bridge serialization omits members whose value is `JsonNull`: nullable contract fields such as status `taskId`/`kind`/`lastPathEvent`, chat `senderUuid`/`senderName`, and pause `reason` can be absent on the wire. Consumers must treat missing keys as null, as the controller does. [Qc-baritone] [Qc-guards] [Qc-control] [controller/main.ts](../controller/main.ts) [D-07, D-09, D-20]

`PauseReason = "hotkey" | "manual_input" | "lease_expired" | "console"`. [D-11, D-35]

| Method | Exact params | Exact result | Behavior / backing API |
|---|---|---|---|
| `qc.baritone.goto` | `{x:number,y?:number,z:number,range?:number}` | `{started:true,taskId:string}` | `ICustomGoalProcess.setGoalAndPath`: y + range → `GoalNear`; y without range → `GoalBlock`; y omitted → `GoalXZ`, ignoring range. [goal process][B-goal], [XZ][B-xz], [near][B-near], [block][B-block] [D-08] |
| `qc.baritone.mine` | `{blocks:string[],targetCount:number}` | `{started:true,taskId:string}` | `IMineProcess.mineByName(targetCount, blocks...)`; count is desired final matching inventory count, not new blocks broken. [interface][B-mine], [implementation][B-mine-impl] [D-08, D-27] |
| `qc.baritone.follow` | `{player:string}` | `{started:true,taskId:string}` | `IFollowProcess.follow(Predicate<Entity>)`; the mod resolves the name against loaded client players and returns error code `player_not_loaded` for an unknown/unloaded player. Both `go_to_player` and `follow_player` use this RPC; approach stops within 3 blocks. [Qc-baritone] [controller/skills.ts](../controller/skills.ts) [D-08, D-09] |
| `qc.baritone.explore` | `{x:number,z:number}` | `{started:true,taskId:string}` | `IExploreProcess.explore(centerX,centerZ)`. [explore interface][B-explore] [D-08, D-19] |
| `qc.baritone.stop` | `{}` | `{stopped:true}` | Cancel current Baritone task via `IPathingBehavior.cancelEverything`; does not itself toggle harness pause. [pathing interface][B-pathing] [D-08, D-20] |
| `qc.baritone.status` | `{}` | `{active:boolean,taskId:string|null,kind:string|null,lastPathEvent:string|null}` | Companion task record plus owned process `isActive`; last event is diagnostic, not a success flag. [process interface][B-process], [path enum][B-path-events] [D-08, D-20] |
| `qc.control.lease` | `{ttlMs:number}` | `{paused:boolean,reason:PauseReason|null}` | Heartbeat: default ttl 3000 ms, sent every 1000 ms; renew deadline without implicitly resuming a pause. [D-11] |
| `qc.control.pause` | `{reason:"console"}` | `{paused:true}` | Apply full stop sequence below and emit `qc.pause`. [D-11] |
| `qc.control.resume` | `{}` | `{paused:false}` | Release pause state; controller replans rather than silently reviving canceled work. [D-11, D-20] |
| `qc.control.state` | `{}` | `{paused:boolean,reason:PauseReason|null,leaseExpiresInMs:number}` | Return pause/lease snapshot, with nonnegative remaining lease time. [D-11] |
| `qc.chat.send` | `{text:string}` | `{sent:boolean,asCommand:boolean,rejected?:"rate_limited"|"too_long"|"command_not_allowed"}` | Guarded vanilla `connection.sendChat`/`sendCommand`, not raw `chat.send` forwarding; see §6. [existing send path][M-chat-send] [D-18, D-29, D-36] |
| `qc.session.respawn` | `{}` | `{ok:boolean}` | Request ordinary client respawn when dead; exact 26.3 vanilla method is V15, not assumed. [D-24] |
| `qc.session.connect` | `{host:string,port:number}` | `{started:boolean}` | Begin client connection flow; acceptance is not successful join, which arrives as `qc.join`; exact classes are V15. [D-24, D-34] |
| `qc.hud.set` | `{goal?:string,action?:string,status?:string}` | `{ok:true}` | Update supplied HUD fields; omitted fields stay unchanged, empty strings clear them; no gameplay action. [Qc-control] [D-23] |
| `qc.config.apply` | `{reflex:ReflexConfig,protect:ProtectConfig,chat:ChatLimits,commandAllowlist:string[],nicknames:Nicknames}` | `{ok:true}` | Apply mod-side hard-guard/reflex configuration and authoritative username/Jared matching; shapes below. [D-10, D-18, D-26, D-29, D-48, D-32, D-36] |
| `qc.world.state` | `{}` | `{dimension:string,dayTime:number,gameTime:number,raining:boolean,thundering:boolean}` | Read the client level for controller observations, not a server-owned world API; official accessor names are V05. [D-01, D-07] |
| `qc.placed.near` | `{x:number,y:number,z:number,radius:number}` | `{blocks:{x:number,y:number,z:number,id:string}[]}` | Current joined server+dimension only; radius clamped to 0..16 blocks, nearest first, maximum 64 entries with matching current block ids. Lazily drop stale entries; no world → `RpcException.unavailable`. [D-49] |

**V04 — Goal conversion resolved.** Finite integer-sized coordinates are floored; finite nonnegative range is floored with a 46340 integer-square ceiling, and `targetCount` must be a positive integer. Invalid block IDs/unloaded players are rejected before starting. Goal selection remains y+range → `GoalNear`, y only → `GoalBlock`, no y → `GoalXZ` (ignoring range). [Qc-baritone] [D-08]

Binding shapes: `ReflexConfig={enabled:boolean,eatAtFood:number}`, `ChatLimits={minIntervalMs:number,maxLen:number}`, `Nicknames={names:string[],wholeWords:string[]}`; `ProtectConfig` is defined in §9. [D-18, D-26, D-48, D-32] The controller maps `chat.nicknames=["SirWaffleshnoz"]` to `nicknames.names` and `chat.wholeWords=["jared"]` to `nicknames.wholeWords`; the mod's `mentionsMe` is authoritative. [D-48] `chat.maxLinesPerReply=2` stays a controller reply policy, not a `ChatLimits` field. [D-18]

**V05 — Client world state resolved.** `qc.world.state` reads `level.dimension().identifier()`, `getOverworldClockTime()` for legacy `dayTime` (`getDayTime` was removed), `getGameTime()`, `isRaining()` and `isThundering()`. No client world yields an unavailable RPC error, never a server-world substitute. [Qc-baritone] [D-01, D-07]

## 5. Events and completion

These are event `data` contracts; MCPFabric supplies the outer event id/type/gameTime envelope. [event model][M-event-model], [event bus][M-bus] [D-07]

| Exact type | Exact data | Emission / evidence |
|---|---|---|
| `qc.chat` | `{kind:"player"|"system"|"whisper",senderUuid:string|null,senderName:string|null,text:string,signed:boolean,mentionsMe:boolean,self:boolean}` | Fabric CHAT/GAME hook plus conservative classification; see §6. [receive API][F-receive] [D-14, D-48, D-36] |
| `qc.pause` | `{paused:boolean,reason:PauseReason|null}` | Pause transition, including resume with null reason. [D-11] |
| `qc.task` | `{taskId:string,kind:string,state:"at_goal"|"calc_failed"|"canceled"|"lost_control",detail?:string}` | Correlate Baritone signals with companion-owned task id; the controller alone declares done/failed after checking the task postcondition. [path enum][B-path-events], [process lifecycle][B-process] [D-08, D-20, D-42] |
| `qc.reflex` | `{name:string,action:string}` | Report a reflex action, not every unchanged tick. [D-32] |
| `qc.death` | `{x:number,y:number,z:number,message:string}` | Once per observed local death; message hook is V16. [D-24] |
| `qc.disconnect` | `{reason:string}` | Once per disconnect; Fabric provides callback, but reason extraction is V16. [connection API][F-connect] [D-24, D-34] |
| `qc.join` | `{host:string,port:number}` | Successful client JOIN, with endpoint retained from connection state. [connection API][F-connect] [D-24] |

| Baritone observation | Implemented `qc.task.state` | Interpretation |
|---|---|---|
| `AT_GOAL` | `at_goal` | Goal signal; the controller verifies position before declaring completion. [path enum][B-path-events] [D-08, D-09, D-42] |
| `CALC_FAILED` / `NEXT_CALC_FAILED` | `calc_failed` | Diagnostic calculation failure; mining may retry, but controller jobs stop after 5 consecutive failures (`MAX_PATH_FAILURES`) instead of waiting for the 120-second budget. Shipped in `a871634`. [controller/skills.ts](../controller/skills.ts) [path enum][B-path-events], [mine implementation][B-mine-impl] [D-08, D-42, D-49] |
| `CANCELED` / explicit task cancellation | `canceled` | Cancellation signal, not a completion verdict: mining also cancels when its inventory target is met, so the controller checks the postcondition. [path enum][B-path-events], [mine implementation][B-mine-impl] [D-20, D-42] |
| Owned process becomes inactive or relinquishes control, detected by polling | `lost_control` | Each client tick polls `isActive()` and `mostRecentInControl()` for the owned process; no Baritone-internals mixins or `onLostControl` observer hook. The signal is not an outcome verdict. [Qc-baritone] [D-08, D-32, D-42] |

Baritone path events contain no harness task id; `isPathing()` is false during pauses, and both goal arrival and calculation failure deactivate the custom goal process. [path enum][B-path-events], [pathing][B-pathing], [custom goal lifecycle][B-goal-impl]

[INFERENCE] Maintain one owned task record and correlate only while it is current; controller skills check position/inventory/block state before returning `{ok,summary,observedDelta}`. [process lifecycle][B-process], [goal lifecycle][B-goal-impl] [D-08, D-09, D-20] The mod emits only the four diagnostic states above; only the controller declares a task done/failed after its postcondition check, never from inactivity alone. [goal lifecycle][B-goal-impl], [inventory check][B-mine-impl] [D-42]

**V06 — Task signal capture resolved.** A public `AbstractGameEventListener.onPathEvent` correlates path signals with the current task; client-tick polling detects owned-process loss of control when no path signal already covers it. No Baritone-internals mixin is needed. The controller still owns completion after fresh postcondition checks. [Qc-baritone] [D-08, D-09, D-32, D-42]

## 6. Chat hooks and sending

Fabric `ClientReceiveMessageEvents.CHAT` receives component, nullable signed message, nullable profile, chat type, and timestamp; `GAME` receives only component and overlay flag. [receive API][F-receive] Profileless disguised chat can carry null message/profile; formatted sender names and system whispers must not establish authenticated identity in the harness. [chat mixin][F-chat-mixin] [D-14, D-17]

| Field / policy | Companion interpretation |
|---|---|
| `kind` | CHAT → `player`; GAME → `system`; recognizable whisper formats → `whisper` [INFERENCE], without turning text into an instruction. [receive API][F-receive] [D-14, D-17, D-36] |
| `senderUuid`, `senderName` | Copy callback profile when present; otherwise null unless a clearly labeled heuristic extracts a name; never fabricate a UUID. [receive API][F-receive] [D-14] |
| `signed` | Preserve whether a signature is present, not a claim that server-rendered text is trusted; exact message API/signature semantics are V07. [receive API][F-receive], [chat mixin][F-chat-mixin] [D-14, D-17] |
| `mentionsMe` | Authoritative mod matching from the `nicknames` parameter of `qc.config.apply`: `names=["SirWaffleshnoz"]` uses case-insensitive substring matching; `wholeWords=["jared"]` uses case-insensitive whole-word matching. Controller may recompute but does not replace the event's value; whispers count as addressed independently. [D-48, D-36] |
| `self` | Compare profile UUID with local player first; absent identity permits conservative own-echo matching [INFERENCE], not suppression of arbitrary same-text chat. [receive API][F-receive] [D-14, D-48] |
| Delivery | Emit chat lines for context; only incoming non-self `player` messages with `mentionsMe=true` or incoming non-self whispers wake the controller. Non-addressed chat stays observation `recentChat` context for the next turn and does not wake the model; suppress own reply loops. [D-48, D-36] |

`qc.chat.send` enforces at least 3000 ms between accepted sends, at most 256 characters, and exact first-token membership for slash-prefixed commands in `commandAllowlist`; rejected sends return the declared rejection value without transmitting. [D-18, D-29, D-36] Allowlist: `/spawn`, `/home`, `/sethome`, `/msg`, `/r`; public/private sends share the limiter, and the controller splits replies into at most two lines. [D-18, D-29, D-36]

Implement protection and outgoing chat/command guards with mixins on the client action path so raw MCPFabric and Baritone calls are also covered; `qc.chat.send` is the controller's only send path but not the guard's only coverage. [D-07, D-10, D-18, D-26, D-29] Reject agent text starting with `#` using the existing `rejected:"command_not_allowed"` result, without adding an enum value; exact mixin targets and pre-interception ordering are V12/V13. [D-07, D-10, D-18, D-26, D-29]

MCPFabric's existing `chat.send` calls vanilla `sendChat`, or gated `sendCommand` after stripping `/`; with `enableCommands=false`, it cannot serve the allowlisted-command lane. [send implementation][M-chat-send] The companion checks its allowlist and calls the vanilla path itself while keeping MCPFabric's unrestricted command RPC disabled. [D-07, D-10, D-29, D-36]

**V07 — Metadata accessor resolved; live signing/formatting pending.** `signed` means signature provenance via `message.hasSignatureFrom(profile.id())` with non-null message/profile, not authorization or a claim of validated server text. Vanilla `sendChat`/`sendCommand` are the outgoing paths. [Qc-guards] [D-14, D-17, D-36] [VERIFY] Prove secure-chat acceptance, RayCraft whisper formats and own echoes on the live server. [D-14, D-36, D-38]

Fabric also exposes `ClientSendMessageEvents.ALLOW_CHAT`/`ALLOW_COMMAND`; command callbacks omit the leading slash and cancellation prevents transmission. [send API][F-send] Use outgoing interception only for guards, never to add an in-game instruction channel. [D-05, D-10]

## 7. Pause, lease, and physical takeover

| Control | Required behavior |
|---|---|
| F8 | Rebindable keybinding, category `qwencraft`; toggles pause with reason `hotkey`. [D-11, D-35] |
| Physical input | Physical WASD/jump/sneak/attack/use or mouse look triggers `manual_input`, including an upgrade from console/lease pause; a human-control pause is never downgraded by later nonhuman pauses. [Qc-control] [mod/src/main/java/dev/qwencraft/QcState.java](../mod/src/main/java/dev/qwencraft/QcState.java) [D-11] |
| Console | `stop` invokes `qc.control.pause` with `{reason:"console"}`; `resume` invokes `qc.control.resume`. [D-05, D-11] |
| Dead-man | Expired `qc.control.lease` triggers `lease_expired`; heartbeat alone does not resume. [D-11] |

Pause cancels Baritone, stops MCPFabric navigation/mining, releases all synthetic movement/attack/use inputs, and emits `qc.pause`; a resume permits new work rather than restarting the canceled task. [D-11, D-20] Activation, takeover and stop transitions produce no lifecycle chat. Other players see chat only when Jared types in-game himself (or uses operator-console `say <text>`) or the agent replies to an incoming non-self addressed message: the account username (case-insensitive substring), whole-word Jared (case-insensitive), or any whisper. The controller rejects chat tools with `chat is only for replying to a message that mentions you` unless the current request carries an incoming non-self `player` event with `mentionsMe=true` or a `whisper` in observation `recentChat` or pending `mustReply`; non-addressed context alone is insufficient, and allowlisted commands such as `/home` remain separate. [D-48, D-47, D-29]

`control.stop` calls only `BotController.stopAllMovement`; MCPFabric separately exposes `stopMining` and `stopNavigation`, and `control.stopUsing` clears use and stops the held-item action. [control implementation][M-control], [bot implementation][M-bot] Baritone documents that `cancelEverything()` can leave an uncancelable movement finishing. [Baritone cancellation][B-pathing] [INFERENCE] A single cancellation call therefore does not prove the four-stop acceptance criterion. [D-11, D-38]

**V08 — Keybinding API resolved.** Fabric 0.161.0+26.3 uses `KeyMappingHelper` (renamed from `KeyBindingHelper`), `registerKeyMapping` and `KeyMapping.Category.register(Identifier...)`; F8 is rebindable. [Qc-control] [D-11, D-35] [VERIFY] Operator must physically test F8 in-world and with screens open; the bench did not exercise physical input. [D-38]

**V09 — Physical API resolved; operator test pending.** Minecraft 26.3 uses SDL, not GLFW: bound keyboard keys use `InputConstants.isKeyDown`, mouse buttons use `SDLMouse.SDL_GetMouseState`, and a `MouseHandler` mixin captures physical look. Synthetic `KeyMapping.isDown()` is not a physical-input detector; vanilla mappings are captured at `CLIENT_STARTED`. [Qc-control] [mod/src/main/java/dev/qwencraft/control/mixin/MouseHandlerMixin.java](../mod/src/main/java/dev/qwencraft/control/mixin/MouseHandlerMixin.java) [D-11] [VERIFY] Physically prove takeover, no agent-input false positives, and preservation of the user's held keys. [D-38]

Use `ClientTickEvents.END_CLIENT_TICK` for lease/reflex bookkeeping; the API supplies the Minecraft client to the callback. [tick API][F-tick] [D-11, D-32]

[VERIFY] **V10 — Complete stop.** Prove complete release despite tick ordering, queued RPCs, active mining/use, navigation, and Baritone's uncancelable movement caveat; prevent stale queued mutations from reasserting inputs after pause. [client dispatch][M-dispatch], [main-thread dispatch][M-thread], [Baritone cancellation][B-pathing] [D-11, D-38] Measure tick stalls rather than claiming a guaranteed 50 ms emergency response. [VERIFY] [D-11, D-38]

## 8. Java reflexes and ownership

Run the reflex checks at nominal 20 Hz in the mod; use TypeScript `onTick` only for additional intents, not as the sole survival watchdog. [D-25, D-32]

| Reflex | Trigger / response |
|---|---|
| Eat | Food ≤ `reflex.eatAtFood` (default 14), edible item present: select/use food and stop use after the observed eating postcondition. [D-32] |
| Escape | Lava/fire/drowning: interrupt ordinary work and attempt a safe escape using local observations. [D-32] |
| Fight back | A hostile that damaged the player: defend against that attacker, not proactive attacks on nearby players. [D-17, D-32] |

Reflexes preempt ordinary work: beginning a reflex cancels Baritone and MCPFabric movement/mining/navigation and releases held item/use/attack controls. Baritone is canceled and its override keys cleared every tick while a reflex runs; stale MCP work and competing action paths are gated. Retained jobs are not resumed; the controller replans after settling. [Qc-reflex] [Qc-control] [D-08, D-20, D-32]

Reflexes run when `ReflexConfig.enabled=true`, except that hotkey/manual-input pause disables them; console/lease-expired pauses stop controller work but retain Java survival reflexes. [D-11, D-32] Test dead-man input release in a full-food, no-hazard spot, not by expecting reflexes to be disabled. [D-11, D-32, D-38]

**V11 — Reflex execution resolved; live survival proof pending.** Priority is hazard escape, hostile-damage retaliation, then eating. Edible selection requires `FOOD` and `CONSUMABLE` components; retaliation uses the recent hostile damage source and vanilla range/cooldown checks. Human pause disables all reflexes. The controller's settling rule is at least 1.5 seconds after the last `qc.reflex` and `player.getState.usingItem=false`, not a mod completion event. [Qc-reflex] [controller/main.ts](../controller/main.ts) [D-11, D-17, D-32] [VERIFY] Exercise live hazard escape/retaliation and settling behavior; the timing heuristic is not proof every escape/fight has ended. [D-38]

## 9. Protection and Baritone settings

`ProtectConfig = {naturalBlocks:string[], zones:{name:string,min:[x,y,z],max:[x,y,z]}[]}`. The existing break mixin permits a block if it is natural, inside an operator zone, or an unchanged tracked agent placement while `!QcState.paused()`. The own-placement exception grants no new permission over Jared's or other players' builds; human takeover retains normal human controls. [D-10, D-26, D-49, D-11] [Qc-break-mixin] [Qc-guards]

Track successful block placements through `MultiPlayerGameMode.useItemOn` while `!QcState.paused()`; this covers controller skills and Baritone pillaring. Placements while paused for **any** reason are human placements and are not tracked. Store `{server,dimension,x,y,z,id}`, with joined server address `host:port` and the namespaced block id observed after placement, in `<gameDir>/config/qwencraft-placed.json`. Load on join; save on change with atomic replacement. When checked, lazily discard entries whose current block id differs (broken or changed); on successful destruction of a tracked position, remove its entry. The new RPC is read-side discovery for this same guard, not independent breaking authority. [D-49] [Qc-break-mixin]

| Setting | Harness value | Verified meaning / caveat |
|---|---|---|
| `allowBreak` | `true` | Default true; permission remains subject to protect guard. [settings][B-basic-settings] [D-26, D-28] |
| `allowPlace` | `true` | Default true. [settings][B-basic-settings] [D-28] |
| `allowSprint` | `true` | Default true. [settings][B-basic-settings] [D-28] |
| `allowParkour` | `true` | Deliberate override: upstream default is false, not true. [settings][B-parkour-settings] [D-28] |
| `legitMine` | `false` | Upstream describes enabling it to avoid looking like X-ray mining; keep the operator's accepted cache-based policy. [settings][B-mining-settings] [D-27] |
| `chatControl` | `false` | Disable ordinary chat-command interpretation; this does not alone disable `#` prefixed commands. [settings][B-chat-settings], [command interception][B-chat-control], [default prefix][B-prefix-settings] [D-05, D-08, D-10] |
| `prefixControl` | `false` | Separately disable default `#` prefixed command interpretation; outgoing agent `#` text is also rejected by the guard. [command interception][B-chat-control], [default prefix][B-prefix-settings] [D-05, D-08, D-10] |
| `blocksToDisallowBreaking` | All registered blocks minus `naturalBlocks` | Upstream defines this as blocks Baritone is not allowed to break. [settings][B-disallow-settings] [D-26] |
| `blocksToAvoidBreaking` | Retain upstream default | Crafting table, furnace, chest, trapped chest: avoidance is not the hard prohibition list. [settings][B-avoid-settings] [D-26] |
| `logger` | `settings.logger` → `Qc.LOG.info("[Baritone] {}", message.getString())` | Status/failure lines go to the game log, not the chat HUD; shipped in `a871634`. [Qc-baritone] [D-47, D-49] |

Baritone's block-type disallow list cannot encode coordinates; keep it restrictive even inside free zones or for tracked placements. Baritone cannot route through its own non-natural placed blocks: the model must inspect `ownBlocksNearby` and dig out with `break_block`, rather than retrying the same blocked path. Zone-only breaking likewise uses the companion-guarded skill path. [disallow setting][B-disallow-settings] [D-26, D-49] [Controller](30-controller.md#5-observation-schema) [INFERENCE] A natural-block allowlist still cannot distinguish placed natural blocks from world generation, so tracking adds a narrow exception, not general ownership detection. [D-26, D-49]

Home radius is a controller-only phase-1 bound measured by horizontal x/z distance: reject `go_to`/`explore`/`go_to_player`/`follow_player` targets outside `selfGoal.radius=256`; poll position and stop the job beyond radius + 16. [D-31, D-37, D-39] Baritone's intermediate path itself is not fenced, and there is no mod RPC for a home fence. [D-31, D-37] When `home=null`, the controller sends allowlisted `/home` once, waits for arrival, records that position as `home`, and prints it to the terminal; console `home set` overrides. [D-29, D-40]

**V12 — Hard-guard targets resolved.** Break hooks target `MultiPlayerGameMode.startDestroyBlock`, `continueDestroyBlock` and `destroyBlock`; D-49 adds placement tracking at `useItemOn` and removal after successful `destroyBlock`. Send hooks target `ClientPacketListener.sendChat`, `sendCommand` and `sendUnattendedCommand`, including its delayed confirmation lambda. Guards cover raw MCPFabric and Baritone action paths and permit ordinary human control after human takeover. [Qc-break-mixin] [Qc-chat-mixin] [Qc-guards] [D-10, D-11, D-18, D-26, D-49] [VERIFY] Complete the raw-path/zone/own-placement/pause matrix on RayCraft. [D-25, D-38]

**V13 — Baritone chat interception implemented.** Both `chatControl=false` and `prefixControl=false` are applied; priority-700 outgoing mixins reject agent `#` text before Fabric/Baritone interception. The local bench observed command allowlist and `#` rejection; [VERIFY] repeat under the live client stack. [Qc-baritone] [Qc-chat-mixin] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04) [D-05, D-08, D-10, D-38]

The mining and movement selections are not an anti-cheat guarantee: historical reports describe Matrix kicks from mining and rotation-related flags, not verified 26.3 RayCraft failures. [Matrix report](https://github.com/cabaletta/baritone/issues/891), [rotation report](https://github.com/cabaletta/baritone/issues/4018) [D-02, D-27, D-28]

## 10. HUD and session lifecycle

Render four client-only HUD lines: `Qwen active` in green or `PAUSED (<reason>)` in red, then `Goal: <goal>`, `Action: <action>`, and `Status: <status>`. `qc.hud.set` updates goal/action/status independently; omission preserves a field and an empty string clears it. The mod tracks when the status text last changed and appends ` (<N>s)` after it has remained unchanged for at least 2 seconds, with N the whole elapsed seconds; sending the same status again does not reset this timer. Truncate each line to screen width. [Qc-control] [D-23]

The controller owns activity text: status distinguishes waiting for Qwen, thinking, memory summarization, running a tool, idle and retry backoff; action reports the current tool/compact arguments and then its done/failed summary, never model prose or reasoning. Exact strings and length limits are in [30-controller.md](30-controller.md#6-loop-cancellation-and-self-goals). [controller/loop.ts](../controller/loop.ts) [D-21, D-23]

**V14 — HUD API resolved.** `HudElementRegistry.addLast` supplies `GuiGraphicsExtractor`; the renderer uses its `fill`/`text` methods and respects `mc.gui.hud.isHidden()`. It does not use old `HudRenderCallback`/draw-context assumptions. [Qc-control] [D-23] [VERIFY] Operator checks placement/scaling/visibility on the live client. [D-38]

`qc.session.respawn` requests normal local-player respawn; `qc.session.connect` initiates the vanilla connection screen flow for `{host,port}`; neither teleports the player or grants server authority. [D-10, D-24] Successful JOIN emits `qc.join`, and disconnect cancels the owned task/inputs before controller policy considers reconnect. [Fabric JOIN/DISCONNECT][F-connect] [D-10, D-24, D-34]

**V15 — Session APIs resolved.** Respawn uses `LocalPlayer.respawn()` only for an available dead/dying player. Connect uses `ConnectScreen.startConnecting(parent,client,ServerAddress,ServerData,false,null)`, refuses an already loaded world/active connect screen, and validates host/port. Both execute through `Qc.onMain`. [Qc-baritone] [D-24] [VERIFY] Exercise live death/reconnect transitions and pause precedence. [D-38]

**V16 — Lifecycle capture implemented.** Death is reported once per death from the local combat-kill packet/`DeathScreen` cause accessor with coordinate snapshots; disconnect uses connection `DisconnectionDetails` and a `DisconnectedScreen` accessor before clearing state. JOIN retains `ServerData` host/port, falling back to remote/requested address. [Qc-baritone] [mod/src/main/java/dev/qwencraft/baritone/mixin/ClientPacketListenerMixin.java](../mod/src/main/java/dev/qwencraft/baritone/mixin/ClientPacketListenerMixin.java) [D-24, D-34] [VERIFY] Verify actual RayCraft causes, manual joins and reconnect UI transitions. [D-38]

The controller owns auto-respawn and reconnect policy: at most 3 reconnects before a counter reset after 1 hour of stable connection without a disconnect; a fourth disconnect before reset stops the agent until console `resume`. [D-24, D-34, D-41] Backoff is `[30000,120000,600000]` ms, with no retry for stop patterns `["ban","banned","kicked by"]`; the mod exposes primitives/events rather than a competing retry loop. [D-24, D-34, D-41]

## 11. MCPFabric configuration

Set these values in the shared `.minecraft/config/mcpfabric.config.json`; MCPFabric loads that file, generates a token when blank, and persists its configuration. [configuration][M-config] [D-10, D-12] Preserve the token locally without documenting or logging it. [D-10]

| Exact key | Selected value | Purpose |
|---|---|---|
| `host` | `127.0.0.1` | Loopback-only tower bridge. [configuration][M-config] [D-03, D-10] |
| `requireAuth` | `true` | Bearer-authenticated bridge calls. [configuration][M-config] [D-10] |
| `enableWorldWrite` | `false` | Disable MCPFabric world-write/admin capability lane. [configuration][M-config] [D-10] |
| `enableCommands` | `false` | Disable unrestricted MCPFabric commands; allowlisted companion commands remain separately guarded. [configuration][M-config], [chat gate][M-chat-send] [D-10, D-29, D-36] |
| `enablePlayerControl` | `true` | Permit local-player harness control. [configuration][M-config] [D-01, D-10] |
| `enableVision` | `true` | Permit the on-demand screenshot lane. [configuration][M-config] [D-10, D-22] |

Keep bridge `http://127.0.0.1:25599`; `/health` is unauthenticated, unlike `/rpc` and `/events`, so health alone never proves authorized controls or safe guard enforcement. [HTTP bridge][M-http], [configuration][M-config] [D-07, D-10, D-38]

Local build/client/gameplay results and outstanding physical/live checks are recorded in [installation and verification](50-install-and-verification.md); bench success does not establish D-38 RayCraft acceptance. [D-38]

[M-limits]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/docs/AGENT.md#L76-L108
[M-chat-hook]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/fabric/FabricClientEntrypoint.java#L18-L28
[M-chat-events]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/ClientEvents.java#L14-L29
[M-control]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/ControlHandlers.java#L16-L90
[M-interact]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/InteractHandlers.java#L61-L290
[M-release]: https://api.modrinth.com/v2/project/mcpfabric/version
[M-mod]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/resources/fabric.mod.json#L1-L4
[M-maven]: https://support.modrinth.com/en/articles/8801191-modrinth-maven
[M-license]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/LICENSE#L1-L21
[M-access]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/McpFabric.java#L46-L52
[M-core]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/McpFabric.java#L54-L82
[M-router]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/RpcRouter.java#L12-L53
[M-bus]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/events/EventBus.java#L18-L69
[M-event-model]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/events/GameEvent.java#L6-L15
[M-dispatch]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/ClientMc.java#L18-L72
[M-thread]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/MainThread.java#L24-L64
[M-http]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/HttpBridgeServer.java#L23-L191
[M-poll]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/handlers/ChatHandlers.java#L23-L53
[M-chat-send]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/ClientChatHandlers.java#L9-L29
[M-bot]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/BotController.java#L60-L224
[M-config]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/config/McpConfig.java#L13-L76
[F-props]: https://github.com/FabricMC/fabric-example-mod/blob/44465cb0eb83932c72ece5934d32ddfc758802ed/gradle.properties#L1-L17
[F-build]: https://github.com/FabricMC/fabric-example-mod/blob/44465cb0eb83932c72ece5934d32ddfc758802ed/build.gradle#L1-L55
[F-wrapper]: https://github.com/FabricMC/fabric-example-mod/blob/44465cb0eb83932c72ece5934d32ddfc758802ed/gradle/wrapper/gradle-wrapper.properties#L1-L9
[F-deps]: https://github.com/FabricMC/fabric-docs/blob/f17bf08e377fc572169fee8df71bbef95628ed2d/develop/loader/fabric-mod-json.md#L215-L229
[F-tick]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-lifecycle-events-v1/src/client/java/net/fabricmc/fabric/api/client/event/lifecycle/v1/ClientTickEvents.java#L29-L75
[F-connect]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-networking-api-v1/src/client/java/net/fabricmc/fabric/api/client/networking/v1/ClientPlayConnectionEvents.java#L42-L81
[F-receive]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-message-api-v1/src/client/java/net/fabricmc/fabric/api/client/message/v1/ClientReceiveMessageEvents.java#L204-L234
[F-chat-mixin]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-message-api-v1/src/client/java/net/fabricmc/fabric/mixin/client/message/ChatListenerMixin.java#L48-L90
[F-send]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-message-api-v1/src/client/java/net/fabricmc/fabric/api/client/message/v1/ClientSendMessageEvents.java#L29-L99
[B-setup]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/SETUP.md#L24-L41
[B-mod]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/fabric/src/main/resources/fabric.mod.json#L1-L29
[B-assets]: https://github.com/cabaletta/baritone/releases/expanded_assets/v1.20.0
[B-publication]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/fabric/build.gradle#L93-L105
[B-license]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/LICENSE#L18-L126
[B-api]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/BaritoneAPI.java#L44-L50
[B-provider]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/IBaritoneProvider.java#L40-L52
[B-goal]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/ICustomGoalProcess.java#L46-L54
[B-xz]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalXZ.java#L45-L57
[B-near]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalNear.java#L34-L47
[B-block]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalBlock.java#L49-L66
[B-mine]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IMineProcess.java#L30-L107
[B-mine-impl]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/process/MineProcess.java#L70-L100
[B-follow]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IFollowProcess.java#L30-L58
[B-explore]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IExploreProcess.java#L22-L27
[B-pathing]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/behavior/IPathingBehavior.java#L74-L105
[B-process]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IBaritoneProcess.java#L48-L95
[B-path-events]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/event/events/PathEvent.java#L20-L33
[B-goal-impl]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/process/CustomGoalProcess.java#L98-L134
[B-bus]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/event/listener/IEventBus.java#L28-L36
[B-listener]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/event/listener/AbstractGameEventListener.java#L31-L79
[B-basic-settings]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L59-L78
[B-parkour-settings]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L351-L369
[B-mining-settings]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L1188-L1192
[B-chat-settings]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L680-L689
[B-chat-control]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/command/ExampleBaritoneControl.java#L62-L75
[B-disallow-settings]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L244-L249
[B-avoid-settings]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L254-L259
[B-prefix-settings]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L836-L845
[M-pom]: https://api.modrinth.com/maven/maven/modrinth/mcpfabric/0.5.0%2B26.3/mcpfabric-0.5.0%2B26.3.pom

[Qc-baritone]: ../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java
[Qc-control]: ../mod/src/main/java/dev/qwencraft/control/ControlFeature.java
[Qc-reflex]: ../mod/src/main/java/dev/qwencraft/control/Reflexes.java
[Qc-guards]: ../mod/src/main/java/dev/qwencraft/guards/GuardsFeature.java
[Qc-break-mixin]: ../mod/src/main/java/dev/qwencraft/guards/mixin/MultiPlayerGameModeMixin.java
[Qc-chat-mixin]: ../mod/src/main/java/dev/qwencraft/guards/mixin/ClientPacketListenerMixin.java
