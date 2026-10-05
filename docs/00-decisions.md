# Phase-1 harness decisions

**Decision date:** 2026-10-04. **Decision source:** user adjudication via ask tool, as recorded in the supplied design brief; this register preserves those choices rather than deriving operator consent from upstream documentation. [D-00]

**Status:** phase-1 harness implemented and exercised by the orchestrator's local bench E2E; the older model probe excluded gameplay, but is no longer the only evidence. RayCraft D-38 acceptance remains pending. [D-00, D-38] [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

External evidence below supports feasibility, limitations or precedent, not the operator's preferences; `[INFERENCE]` marks reasoning beyond the source, and `[VERIFY]` marks an outstanding build or live-acceptance check. Implementation facts cite repo-relative source paths. [D-00, D-38] [Source catalogue](references.md)

Implementation contracts: [architecture](10-architecture.md), [companion mod](20-companion-mod.md), [controller](30-controller.md), [chat and safety](40-chat-and-safety.md), [installation and acceptance](50-install-and-verification.md). [D-01, D-04, D-10, D-38]

## D-00 — Harness-only scope

**Decision:** phase 1 makes Qwen play through the visible client; house/blueprint architecture is deferred and is not an acceptance requirement. [D-00]

**Alternatives considered:** combining the harness and later architecture work; rejected as phase-1 scope. [D-00]

**Evidence:** MCPFabric documents client perception, skills and important execution limits, including absent smelting execution. [MCPFabric limits][mcp-limits]

**Consequences/risks:** build missing harness skills rather than importing an unverified complete builder; judge completion only against D-38. [D-00, D-38]

## D-01 — Visible in-client control

**Decision:** use Fabric API, MCPFabric, Baritone and the `qwencraft` companion mod to control SirWaffleshnoz in the user's visible tower client. [D-01]

**Alternatives considered:** headless Mineflayer behind ViaProxy; both bodies behind a generic adapter. [D-01]

**Evidence:** Baritone's primary instance belongs to the game-created local player; the observed client username is SirWaffleshnoz. [Primary player][baritone-primary] [Client](evidence/client-process.txt) Mineflayer's pinned 4.39.0 README advertises support through 26.1, while ViaProxy 3.4.13 announces 26.3 support; this is alternative-stack evidence, not a tested RayCraft integration. [Mineflayer README][mineflayer-support] [Mineflayer release][mineflayer] [ViaProxy release][viaproxy]

**Consequences/risks:** retain one body and one account; no speculative body adapter. The chosen stack has controlled the visible development client on the local bench; `[VERIFY]` prove the same stack on the operator's RayCraft client before D-38 acceptance. [D-01, D-38] [Bench](../bench/README.md)

## D-02 — RayCraft is the test target

**Decision:** run phase-1 acceptance directly on third-party RayCraft, using the main account. [D-02]

**Alternatives considered:** an isolated Paper 26.3 server on Spark; singleplayer/LAN. [D-02]

**Evidence:** the captured status ping reports Paper 26.3/protocol 777 and includes SirWaffleshnoz in its sample; Litematica warns that automated placement can trigger server rejection or bans. [Server ping](evidence/raycraft-status-ping.json.txt) [Automation warning][litematica]

**Consequences/risks:** `[INFERENCE]` permission, anti-cheat and account-ban exposure remain external risks; a status ping proves neither approval nor automation compatibility. [D-02] [Automation warning][litematica] `[VERIFY]` establish owner permission and applicable server rules before live automation. [D-02, D-10]

## D-03 — Controller on the tower

**Decision:** run the controller beside the client; use loopback for MCPFabric and the wired Spark endpoint for the model. [D-03]

**Alternatives considered:** controller on Spark with an SSH tunnel back to the client. [D-03]

**Evidence:** MCPFabric defaults to `127.0.0.1:25599`; the recorded model probe reached `http://192.168.100.2:8000/v1/chat/completions`. [Bridge config][mcp-config] [Probe](evidence/vllm-capability-probe.json.txt)

**Consequences/risks:** retain local control and stop mechanisms when model connectivity fails; keep the bridge loopback-only. [D-03, D-10, D-11]

## D-04 — TypeScript/Node controller

**Decision:** use TypeScript/Node for the controller and user heuristics. [D-04, D-25]

**Alternatives considered:** Python. [D-04]

**Evidence:** the tower records Node v24.12.0 and Python 3.14.0; MCPFabric already has TypeScript action-runtime code as borrowing precedent. [Toolchain](evidence/tower-toolchain.txt) [Runtime][mcp-runtime]

**Consequences/risks:** one plugin language, no second implementation; Node 24 runs erasable TypeScript directly, and filesystem watching/cache-busted imports hot-reload heuristics. The local bench exercised hot reload. [D-04, D-25] [controller/package.json](../controller/package.json) [controller/heuristics.ts](../controller/heuristics.ts) [Bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

## D-05 — Terminal is the only instruction channel

**Decision:** accept play instructions only from the local tower console, including free text and the specified console commands. [D-05]

**Alternatives considered:** outgoing `!ai` interception; allowlisted-player whispers; web UI. [D-05]

**Evidence:** Fabric's incoming GAME callback has no sender field, and CHAT sender/signature values can be null. [Chat callback][fabric-chat]

**Consequences/risks:** conversations cannot become authorized movement or inventory tasks, even when they appear to come from friends or the operator. [D-05, D-17]

## D-06 — New repository

**Decision:** keep this project in `D:/qwencraft`, with `mod/`, `controller/`, `heuristics/`, `bench/`, `docs/`, `vendor/` and `qwencraft.config.json`; the 2026-10-04 build greenlight superseded the documentation-only stage, without widening phase 1 beyond the harness. [D-06, D-00] [Repository guide](../README.md)

**Alternatives considered:** no alternate location was recorded; reusing an unrelated project is not an approved choice. [D-06]

**Evidence:** the Fabric example separates Java build inputs; MCPFabric's controller precedent lives under `mcp-server/`. [Example build][fabric-build] [TypeScript runtime][mcp-runtime]

**Consequences/risks:** the operator approved PUBLIC GitHub publication on 2026-10-04. Vendor JARs are not committed: obtain them with `node vendor/fetch.ts`, using the pinned SHA-256 manifest. Global IPv6 addresses in the public `docs/evidence/tower-network.txt` capture are redacted; credentials/runtime logs remain private. Publication approval is not a claim that a remote repository has already been created. [D-06, D-10, D-44] [vendor/SHA256SUMS](../vendor/SHA256SUMS) [Network evidence](evidence/tower-network.txt)

## D-07 — Direct HTTP bridge and owned skills

**Decision:** call MCPFabric's HTTP bridge directly and own the harness skill/job layer; borrow appropriate MIT code rather than depending on its MCP-server runtime lifecycle. [D-07]

**Alternatives considered:** MCP client to upstream `mcp-server`; import that runtime as a library. [D-07]

**Evidence:** the bridge accepts `{method,params}` requests, and upstream issue #33 discusses shared-job/session lifetime; MCPFabric's license is MIT. [HTTP handler][mcp-http] [Issue #33][mcp-33] [License][mcp-license]

**Consequences/risks:** preserve notices for borrowed code and explicitly own cancellation/postconditions; HTTP success is not skill completion. [D-07, D-09, D-20]

## D-08 — Baritone navigation

**Decision:** expose Baritone through the companion mod for phase-1 navigation, mining, following and exploration. [D-08]

**Alternatives considered:** MCPFabric's custom A* alone. [D-08]

**Evidence:** MCPFabric's walker cannot swim, climb ladders, pillar or tunnel; Baritone exposes goal, mining, following and exploration APIs. [Walker limits][mcp-limits] [Goal API][baritone-goal] [Mining API][baritone-mine] [Follow API][baritone-follow] [Explore API][baritone-explore]

**Consequences/risks:** one owner of movement at a time, with event correlation and task-specific postconditions; no chat-command navigation. [D-08, D-09, D-20]

## D-09 — Curated high-level tools

**Decision:** expose the frozen high-level tool set in [30-controller.md](30-controller.md), not the complete raw bridge catalogue. [D-09]

**Alternatives considered:** raw primitives; tiered raw/high-level exposure. [D-09]

**Evidence:** Mindcraft groups travel, inventory, collect/craft/smelt and goal operations as named actions; Baritone mining quantity is the final matching inventory count rather than newly acquired blocks. [Actions][mindcraft-actions] [Mine semantics][baritone-mine-impl]

**Consequences/risks:** each tool verifies a position, inventory or block-state postcondition and returns `{ok,summary,observedDelta}`; translate incremental requests rather than silently inheriting incompatible quantity semantics. [D-09]

## D-10 — Hard safety gates

**Decision:** set MCPFabric `enableWorldWrite=false`, `enableCommands=false`, `enablePlayerControl=true`, `enableVision=true`, `host=127.0.0.1`, `requireAuth=true`; mediate allowed slash commands and block protection through the mod. [D-10, D-26, D-29, D-36]

**Alternatives considered:** forbid every slash command; rejected in favor of an explicit allowlist. [D-10]

**Evidence:** those MCPFabric flags exist and upstream enable defaults are permissive; Baritone supplies a block-type breaking denylist. [Config][mcp-config] [Breaking restrictions][baritone-protect]

**Consequences/risks:** protection hooks target `MultiPlayerGameMode.startDestroyBlock`, `continueDestroyBlock` and `destroyBlock`; chat hooks target `ClientPacketListener.sendChat`, `sendCommand` and `sendUnattendedCommand` (including delayed confirmation), covering raw MCPFabric and Baritone as well as `qc.*`. `[VERIFY]` exercise every mutation and human-handoff path on RayCraft. [D-10, D-11, D-25, D-26, D-38] [Block mixin](../mod/src/main/java/dev/qwencraft/guards/mixin/MultiPlayerGameModeMixin.java) [Chat mixin](../mod/src/main/java/dev/qwencraft/guards/mixin/ClientPacketListenerMixin.java)

## D-11 — Four independent stop controls

**Decision:** support hotkey, manual-input takeover, terminal `stop` and dead-man lease; use `lease.ttlMs=3000` and `lease.intervalMs=1000`. [D-11]

**Alternatives considered:** a subset of those controls; operator chose all four. [D-11]

**Evidence:** MCPFabric has `control.stop`; Baritone notes that `cancelEverything()` can finish an uncancelable movement, so cancellation alone is not proof of released input. [Control API][mcp-control] [Cancellation caveat][baritone-cancel]

**Consequences/risks:** cancel Baritone, clear movement booleans, stop mining/navigation/item use and synthetic attack/use; `control.stop` alone is insufficient. Reflexes stay active under console/lease pauses; human-control reasons upgrade those pauses and disable reflexes. Physical state uses 26.3 SDL APIs, not synthetic mapping state. [D-11, D-32] [mod/src/main/java/dev/qwencraft/control/ControlFeature.java](../mod/src/main/java/dev/qwencraft/control/ControlFeature.java) [mod/src/main/java/dev/qwencraft/QcState.java](../mod/src/main/java/dev/qwencraft/QcState.java) `[VERIFY]` operator must physically prove F8/manual takeover and repeat all four stops on RayCraft, with safe full-food/no-hazard console and lease fixtures. [D-38]

## D-12 — Shared `.minecraft` installation

**Decision:** install Fabric profile `fabric-loader-26.3` into the same `.minecraft` used by the visible client. On 2026-10-04 the operator explicitly approved performing that real-directory installation now; this approval does not itself prove installation or RayCraft acceptance. [D-12, D-38] [Installation runbook](50-install-and-verification.md)

**Alternatives considered:** separate gameDir for isolation. [D-12]

**Evidence:** the client process records `C:\Users\jlyon\AppData\Roaming\.minecraft`; Fabric documents installing/selecting a launcher profile. [Client](evidence/client-process.txt) [Windows install][fabric-install]

**Consequences/risks:** `[INFERENCE]` Fabric profiles using that same gameDir share its `mods/`; this deliberately sacrifices profile isolation. [D-12] [Installer profile][installer-profile] `[VERIFY]` inspect the selected profile's gameDir and shared mods before launch. [D-12]

## D-13 — Example Loom baseline

**Decision:** follow the 26.3 example's Loom `1.18-SNAPSHOT`, Java 25 and non-remapping build arrangement. [D-13]

**Alternatives considered:** MCPFabric's Loom 1.17.11 baseline. [D-13]

**Evidence:** the pinned example declares `loom_version=1.18-SNAPSHOT`, and its build uses `net.fabricmc.fabric-loom`, split environment source sets and Java release 25. [Properties][fabric-properties] [Build][fabric-build]

**Consequences/risks:** the selected JDK 25/Loom build runs the bench companion, but a SNAPSHOT source pin is not an immutable artifact pin; `[VERIFY]` record the resolved Loom artifact identity for reproducible live installation. [D-13, D-38] [mod/build.gradle](../mod/build.gradle) [Bench instructions](../bench/README.md)

## D-14 — Identity-rich companion chat hook

**Decision:** emit `qc.chat` from the companion's Fabric receive hook, preserving nullable UUID/name, signature status and kind. [D-14]

**Alternatives considered:** MCPFabric's existing chat events. [D-14]

**Evidence:** Fabric supplies sender profile, signed message and chat type to CHAT, whereas MCPFabric forwards text and name but discards signed-message metadata. [Fabric callback][fabric-chat] [MCPFabric forwarding][mcp-chat-hook]

**Consequences/risks:** never infer authenticated identity from system text; `[VERIFY]` classify RayCraft's actual whisper format without inventing identity for profileless messages. [D-14, D-17, D-36]

## D-15 — Model considers all chat

**Decision:** **Superseded by D-48 on 2026-10-04, amended by D-54…D-57.** The original all-chat scheduling is retired: incoming non-self addressed player messages, whispers and eligible five-minute conversation follow-ups wake a separate chat lane, never the body lane. Other chat, system lines and replayed history remain `recentChat` context only. [D-15, D-48, D-54, D-55, D-56, D-57]

**Alternatives considered:** addressed-only filtering was originally rejected; D-48 selects it, with D-54 allowing unnamed follow-ups and D-55 separating conversation from gameplay scheduling. [D-15, D-48, D-54, D-55]

**Evidence:** Fabric exposes separate CHAT and GAME receive events; MCPFabric's event ring supports cursor-based recent-event retrieval. [Chat events][fabric-chat] [Event ring][mcp-events]

**Consequences/risks:** suppress own echoes and separate conversation from play authority; chat does not authorize tasks. D-55 removes chat tools from the body lane; system lines and history cannot authorize replies. [D-15, D-17, D-48, D-55, D-56, D-57]

## D-16 — Explicit AI disclosure

**Decision:** explain that SirWaffleshnoz is agent-controlled when asked; no prefix on every message. D-47 removed this decision's start/stop announcements on 2026-10-04; its “explain when asked” rule remains. [D-16, D-47] [controller/chat-policy.ts](../controller/chat-policy.ts)

**Alternatives considered:** prefix every outgoing message. [D-16]

**Evidence:** MCPFabric sends outgoing chat through the local player's normal connection, not as a separately named agent account. [Sending path][mcp-chat-send]

**Consequences/risks:** explain agent control in replies when asked, subject to normal send limits and D-47's reply-only gate. Activation and control changes produce no chat. [D-16, D-18, D-47]

## D-17 — Other players may converse, not command

**Decision:** answer others' questions but never act on their requests. [D-17, D-05]

**Alternatives considered:** act for allowlisted friends; relay requests to the terminal. [D-17]

**Evidence:** Fabric can deliver senderless system messages; Mindcraft warns that its code-enabled bots remain vulnerable to injection attacks on public servers, not that a chat-only qwencraft harness has been tested for that exploit. [Sender limits][fabric-chat] [Code-enabled bot warning][mindcraft-readme]

**Consequences/risks:** retain current operator/self-survival work while speaking; revalidate tool proposals against authorized goal provenance, not model assurances. [D-17, D-19, D-25]

## D-18 — Mod-enforced chat limits

**Decision:** `chat.minIntervalMs=3000`, `chat.maxLen=256`, `chat.maxLinesPerReply=2`; enforce interval/length through `qc.chat.send` and client outgoing-chat/command mixins so raw bridge calls cannot bypass them. [D-18, D-10]

**Alternatives considered:** unrestricted output or controller-only throttling; neither meets the chosen mod-enforced contract. [D-18]

**Evidence:** Paper documents chat/command spam controls; MCPFabric's send handler itself uses the ordinary connection send path. [Paper properties][paper-properties] [Sending][mcp-chat-send]

**Consequences/risks:** operator `say`, public replies, commands and whisper replies remain rate-limited; split long replies into at most two independently spaced messages. [D-18, D-36, D-47] `[INFERENCE]` these limits reduce exposure but cannot promise RayCraft plugin acceptance. [D-18, D-02] [Paper properties][paper-properties]

## D-19 — Idle survival autonomy

**Decision:** idle time advances self-directed survival rather than waiting indefinitely. [D-19]

**Alternatives considered:** idle wait. [D-19]

**Evidence:** Mindcraft's self-prompter provides an idle/repeated-goal precedent; it is not a tested qwencraft implementation. [Self-prompter][mindcraft-self]

**Consequences/risks:** bound self-goals by home radius, protect rules and hard stops; do not turn ambient chat into a survival-goal source. [D-19, D-17, D-26, D-31, D-37]

## D-20 — Cancel and replan on new instructions

**Decision:** a new console instruction cancels current work, increments generation and replans; discard older-generation model responses. [D-20]

**Alternatives considered:** queue instructions; let the model choose whether to interrupt. [D-20]

**Evidence:** Mindcraft has cooperative action interruption, while Baritone cancellation has movement-completion caveats. [Action manager][mindcraft-manager] [Cancel caveat][baritone-cancel]

**Consequences/risks:** reobserve after cancellation rather than assume a rollback; one outstanding model request and one body owner remain the execution rule. [D-20, D-08] `[VERIFY]` prove stale responses cannot restart an obsolete task. [D-20, D-38]

## D-21 — Thinking only for planning

**Decision:** `llm.thinking="planning"`: default off, enabled for new-instruction decomposition and post-failure replans; D-46 narrows that permission to a new console instruction and failed-tool replan on that instruction, not resume/idle/chat/recovery. Do not retain reasoning in rolling history. [D-21, D-33, D-46]

**Alternatives considered:** thinking on every step; always off. [D-21]

**Evidence:** the probe observes separate `message.reasoning` with thinking enabled and null reasoning when disabled; the captured template checks `enable_thinking` and inserts an empty think prefix when false. [Probe](evidence/vllm-capability-probe.json.txt) [Template](evidence/vllm-chat-template.jinja.txt) vLLM's Qwen parser supports tool-call transitions. [Parser][vllm-parser]

**Consequences/risks:** treat reasoning as diagnostic output, not actions; `[VERIFY]` exercise planning-to-execution turns and history serialization against the installed endpoint. [D-21, D-09]

## D-22 — On-demand vision

**Decision:** expose `look_screenshot` on demand rather than attaching every frame to every turn. [D-22]

**Alternatives considered:** text-only observations; continuous screenshot input. [D-22]

**Evidence:** MCPFabric returns PNG/base64 screenshots; the local probe accepted a synthetic red image, and the NVIDIA card describes visual inputs. [Screenshot handler][mcp-vision] [Probe](evidence/vllm-capability-probe.json.txt) [Model card][model-card]

**Consequences/risks:** `[VERIFY]` measure actual Minecraft screenshot usefulness and request size; a red-square test is not gameplay visual competence. [D-22] [Probe](evidence/vllm-capability-probe.json.txt)

## D-23 — In-game HUD

**Decision:** show latest `qc.hud.set` goal/action/thought plus pause state in a client-only HUD overlay. [D-23]

**Alternatives considered:** terminal-only observability; rejected for the selected watch UX. [D-23]

**Evidence:** the chosen Fabric example supports a split client source set; the client process is the operator's SirWaffleshnoz session. [Client build][fabric-build] [Client](evidence/client-process.txt)

**Consequences/risks:** show a concise operator-facing summary, not raw reasoning. The built overlay uses `HudElementRegistry`/`GuiGraphicsExtractor` and respects `mc.gui.hud.isHidden()`; `[VERIFY]` operator checks live placement/scaling/visibility. [D-23, D-21, D-38] [mod/src/main/java/dev/qwencraft/control/ControlFeature.java](../mod/src/main/java/dev/qwencraft/control/ControlFeature.java)

## D-24 — Automatic respawn and reconnect

**Decision:** use `qc.session.respawn` after death and `qc.session.connect` after ordinary disconnect, within D-34/D-41 bounds: at most three reconnects before a one-hour stable-connection reset, then console `resume` is required. [D-24, D-34, D-41]

**Alternatives considered:** require manual recovery; operator selected automatic recovery. [D-24]

**Evidence:** Fabric exposes JOIN and DISCONNECT callbacks; callback availability alone does not implement session recovery. [Connection events][fabric-connection]

**Consequences/risks:** reobserve inventory/location and replan after recovery. Vanilla `LocalPlayer.respawn()` and `ConnectScreen.startConnecting(...)` implement the primitives; `[VERIFY]` prove live recovery respects pause, stop patterns and D-41 bounds. [D-24, D-11, D-34, D-41] [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java)

## D-25 — User heuristic hooks and hot reload

**Decision:** `heuristics/*.ts` default-export `Heuristic`, with `onObservation`, `onPlanProposed`, `onTick`, `onChat`, descending priority and filename tie-breaks; reload on change. [D-25]

**Alternatives considered:** prompt-only customization; cold-load-only modules; neither satisfies the chosen hooks. [D-25]

**Evidence:** Mindcraft's mode scheduler provides prioritized non-model behavior and interruption precedent. [Modes][mindcraft-modes]

**Consequences/risks:** plugins hint/rewrite/veto but cannot disable mod guards; `onTick` is non-blocking at 5 Hz. The bench proved veto and hot reload without restart; `[VERIFY]` repeat behavior and guard isolation on RayCraft. [D-25, D-32, D-38] [controller/heuristics.ts](../controller/heuristics.ts) [controller/loop.ts](../controller/loop.ts) [Local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

## D-26 — Natural-block allowlist and free zones

**Decision:** outside configured zones, break only `protect.naturalBlocks`; inside operator-defined zones, the harness's own skill path may break any block. **Extended by D-49 on 2026-10-04:** the active agent may also break its own tracked, unchanged placements outside zones. On 2026-10-04 the operator accepted the default natural-block list in `qwencraft.config.json` for RayCraft; acceptance is not ownership detection or a universal permission to break placed natural blocks. [D-26, D-49, D-02] [qwencraft.config.json](../qwencraft.config.json)

**Alternatives considered:** unrestricted breaking; no breaking; a block denylist alone cannot express the selected spatial exception. [D-26]

**Evidence:** Baritone has global `blocksToDisallowBreaking` and a separate default avoidance list including crafting tables, furnaces and chests. [Breaking settings][baritone-protect]

**Consequences/risks:** set Baritone's denylist to all registered block types minus the natural allowlist everywhere; free-zone and own-placement exceptions belong only to our guarded `break_block` skill path, not Baritone's type-based planner. [D-26, D-49] [Breaking settings][baritone-protect] [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java) `[VERIFY]` verify the allowlist against the 26.3 registry and prove all agent break paths reject protected blocks outside zones unless they are unchanged tracked agent placements. [D-26, D-49, D-38]

## D-27 — Original mining policy (superseded)

**Decision:** **Superseded by D-50 on 2026-10-04.** The original hidden-target mining policy is retired; ore acquisition now uses legit branch-mining at the selected Y for the first requested mineral. Non-ore collection still uses the loaded-chunk scan. [D-27, D-50]

**Alternatives considered:** exposed-only collection; the original policy, since removed by D-50. [D-27, D-50]

**Evidence:** the initial policy relied on Baritone's mining settings and search behavior. D-50 records the live anti-xray census and the distinction between tracked cached blocks and untracked ores. [Mining setting][baritone-legit] [Mining search][baritone-cache-search] [D-50]

**Consequences/risks:** D-50 replaces the mining mechanism, not the requirement for server permission or moderation-aware stops. [D-27, D-50, D-02, D-34]

## D-28 — Sprint and parkour enabled

**Decision:** `allowBreak=true`, `allowPlace=true`, `allowSprint=true`, `allowParkour=true`; apply D-26 protection, set `chatControl=false` and `prefixControl=false`, and reject agent text starting with `#`. [D-28, D-26, D-05, D-10]

**Alternatives considered:** conservative walking/no parkour; operator chose the more capable movement policy. [D-28]

**Evidence:** Baritone defaults break/place/sprint to true but parkour to false; therefore parkour is an explicit override, not an upstream default. [Basic settings][baritone-basic] [Parkour settings][baritone-parkour] `chatControl` and `prefixControl` are separate controls, and the command handler independently checks prefixed input. [Chat settings][baritone-chat] [Prefix settings][baritone-prefix] [Command interception][baritone-command]

**Consequences/risks:** `[INFERENCE]` permissioned inputs still face Paper/plugin movement checks; enabling parkour is not an anti-cheat guarantee. [D-28, D-02] [Paper movement][paper-spigot] `[VERIFY]` demonstrate movement on approved RayCraft terrain without kicks or protected-block damage. [D-28, D-38]

## D-29 — Base slash-command allowlist

**Decision:** allow `/spawn`, `/home`, `/sethome`; D-36 extends that list for whispers, yielding `commands.allowlist=["/spawn","/home","/sethome","/msg","/r"]`. [D-29, D-36]

**Alternatives considered:** arbitrary slash commands; no slash commands. [D-29, D-10]

**Evidence:** the normal outgoing client path distinguishes chat from slash commands and uses `sendCommand` for commands. [Chat handler][mcp-chat-send]

**Consequences/risks:** `run_command` and `qc.chat.send` must validate the exact first token; `[VERIFY]` check RayCraft supports these commands and establish their actual semantics/permissions. [D-29, D-36, D-10]

## D-30 — Addressing aliases

**Decision:** **Superseded by D-48 on 2026-10-04.** The original additional addressing aliases are retired. Current configuration is `chat.nicknames=["SirWaffleshnoz"]` and `chat.wholeWords=["jared"]`; whispers always count as addressing the agent. [D-30, D-48]

**Alternatives considered:** exact player-name-only matching; the original broader aliases, since removed by D-48. [D-30, D-48]

**Evidence:** the observed username is SirWaffleshnoz; incoming Fabric chat includes rendered text and optional sender metadata. [Client](evidence/client-process.txt) [Incoming chat][fabric-chat]

**Consequences/risks:** addressing supplies attention, not command authority. Send `nicknames:{names,wholeWords}` through `qc.config.apply`; the mod-computed `qc.chat.mentionsMe` is authoritative. D-48 narrows matching to the account username and whole-word `jared`, with whispers independently addressed. [D-30, D-14, D-05, D-48]

## D-31 — Home-centered survival progression

**Decision:** self-goals progress tools → food → iron → shelter/bed near home; initial `home=null` is resolved by one allowlisted `/home` and an observed arrival, then the controller records/prints the position. Console `home set` overrides it. Use D-39 horizontal distance. [D-31, D-19, D-37, D-39, D-40]

**Alternatives considered:** unconstrained exploration; a static idle task. [D-31]

**Evidence:** Mindcraft provides collect/craft/smelt and goal actions as compositional precedents, not an implementation of this selected progression. [Survival actions][mindcraft-actions]

**Consequences/risks:** emergencies may preempt progression; D-40 settles the home source rather than silently adopting first spawn. `[VERIFY]` exercise RayCraft `/home` arrival detection and ensure autonomous progression uses the recorded home and D-39 radius metric. [D-31, D-32, D-37, D-39, D-40]

## D-32 — Java reflex core plus TypeScript intents

**Decision:** implement client-tick Java eat/hazard-escape/fight-back reflexes at 20 Hz, extended by D-52 with `flee_creeper`, with non-blocking TypeScript `onTick` intents around 5–10 Hz; default `reflex.eatAtFood=14`. [D-32, D-25, D-52]

**Alternatives considered:** controller-only reflexes; model-only survival decisions. [D-32]

**Evidence:** Fabric supplies client tick callbacks, while Mindcraft's modes prioritize preservation and defense; the model probe measures second-scale rather than per-tick responses. [Tick hook][fabric-tick] [Modes][mindcraft-modes] [Probe](evidence/vllm-capability-probe.json.txt)

**Consequences/risks:** reflexes survive controller failure, remaining active under console/lease pauses but disabled under human takeover. Beginning a reflex cancels MCP/Baritone work and Baritone stays canceled every tick while it runs; the controller replans after ≥1.5 s since the last `qc.reflex` plus `usingItem=false`. This settling rule is a heuristic, not a completion event. `[VERIFY]` prove live hazard/creeper/retaliation/physical-pause behavior. [D-32, D-52, D-11, D-20, D-38] [mod/src/main/java/dev/qwencraft/control/Reflexes.java](../mod/src/main/java/dev/qwencraft/control/Reflexes.java) [controller/run.ts](../controller/run.ts)

## D-33 — Small durable memory

**Decision:** use rolling context plus a small JSON notes store, rather than a database-backed memory platform. [D-33]

**Alternatives considered:** upstream MCPFabric persistent memory; retrieval/vector-memory infrastructure. [D-33]

**Evidence:** Mindcraft summarizes older turns into a bounded previous-memory string; MCPFabric documents persistent memory as an alternative precedent. [History][mindcraft-history] [MCPFabric memory][mcp-memory]

**Consequences/risks:** store named places/chests/home/zones and concise notes, not full world snapshots; rolling summaries may lose detail, so skills reobserve before acting. [D-33, D-09, D-31]

## D-34 — Bounded reconnect

**Decision:** `reconnect.maxPerHour=3`, `reconnect.backoffMs=[30000,120000,600000]`, `reconnect.stopPatterns=["ban","banned","kicked by"]`; stop rather than retry a detected ban/staff kick. Despite the config key's name, counting follows D-41's stable-hour reset, not a rolling-hour window. [D-34, D-41]

**Alternatives considered:** unlimited reconnect; manual-only reconnect. [D-34, D-24]

**Evidence:** Fabric supplies disconnect notifications but not a typed ban/staff-kick classification in the shown callback signature. [Connection callback][fabric-connection]

**Consequences/risks:** automatic recovery is deliberately bounded; text matching is conservative policy, not authenticated moderation metadata. The fourth disconnect before a one-hour stable reset stops the agent until console `resume`. `[VERIFY]` identify actual RayCraft disconnect text and exercise the D-41 reconnect/reset cases. [D-34, D-24, D-41]

## D-35 — F8 pause toggle

**Decision:** make F8 a rebindable keybinding in category `qwencraft`, toggling the shared pause state. [D-35, D-11]

**Alternatives considered:** no other key was recorded; terminal-only stop is insufficient for the four-control choice. [D-35, D-11]

**Evidence:** Fabric's client tick callbacks supply a local place to process the pause binding independent of network/model work. [Ticks][fabric-tick]

**Consequences/risks:** `[VERIFY]` confirm the 0.161.0+26.3 keybinding API and detect F8 conflicts in the actual profile; rebind if needed without weakening pause semantics. [D-35, D-11]

## D-36 — Private whisper replies

**Decision:** add `/msg` and `/r` to the allowlist; `chat_reply(to,text)` answers a whisper using `/msg <to> <text>`. [D-36, D-29]

**Alternatives considered:** public replies to whispers; suppress whispers. [D-36]

**Evidence:** outgoing vanilla commands use `sendCommand`; incoming GAME messages have no sender profile, so a server-formatted whisper needs separate classification. [Sending][mcp-chat-send] [Receiving][fabric-chat]

**Consequences/risks:** preserve privacy and the common rate limit without granting play authority; `[VERIFY]` validate recipient identity/format and RayCraft whisper command behavior before sending private replies. [D-36, D-14, D-17, D-18]

## D-37 — 256-block self-goal radius

**Decision:** set `selfGoal.radius=256` around the D-40 home for autonomous survival goals; use horizontal x/z distance only, as settled by D-39. [D-37, D-31, D-39, D-40]

**Alternatives considered:** no other numeric radius was recorded; unbounded self-goals were not selected. [D-37]

**Evidence:** Baritone exposes both horizontal-only `GoalXZ` and spherical `GoalNear`; these are different distance semantics, not a supplied self-goal boundary implementation. [GoalXZ][baritone-xz] [GoalNear][baritone-near]

**Consequences/risks:** controller-only target rejection covers `go_to`, `explore`, `go_to_player` and `follow_player`; poll horizontal position and stop the job beyond `radius + 16`. Baritone paths themselves are not fenced: permitted endpoints do not guarantee an in-radius route. `[VERIFY]` exercise target rejection and position polling using D-39's settled horizontal metric, including vertical-only movement that does not consume radius. [D-37, D-31, D-39, D-40]

## D-38 — Phase-1 completion on RayCraft

**Decision:** all rows below are required on RayCraft, with no substitution of local-only success. [D-38, D-02]

| Criterion | Observable outcome |
|---|---|
| Chat Q&A | Answer an addressed player, disclose AI control, respect chat limits. [D-38, D-16, D-18] |
| Console tasks | Go to coordinates/player; collect 16 logs; craft wooden and stone tools; smelt iron. [D-38, D-09] |
| Autonomous survival | 30 minutes without death, kick or breaking crafted blocks. [D-38, D-19, D-26] |
| Stop controls | Hotkey, manual input, terminal stop and lease expiry each release synthetic inputs. [D-38, D-11] |
| Extensibility | Hot reload changes heuristic behavior without client/controller restart. [D-38, D-25] |

**Alternatives considered:** reduced/local-only demonstrations; rejected by the RayCraft-specific acceptance choice. [D-38, D-02]

**Evidence:** the existing probe explicitly performed no gameplay, and MCPFabric documents that smelting execution is absent upstream; therefore model connectivity and upstream tool availability do not discharge these criteria. [Probe](evidence/vllm-capability-probe.json.txt) [Executor limits][mcp-limits]

**Consequences/risks:** `[VERIFY]` execute and capture every criterion using [50-install-and-verification.md](50-install-and-verification.md); do not call phase 1 complete after a chat-only or movement-only demonstration. [D-38]

## D-39 — Horizontal home-radius metric

**Decision:** measure home radius using horizontal x/z distance only: `sqrt((x-home.x)^2 + (z-home.z)^2)`; ignore y for both target rejection and the `radius + 16` running-job stop threshold. This is the operator's 2026-10-04 adjudication. [D-39, D-31, D-37]

**Alternatives considered:** three-dimensional distance; rejected in favor of horizontal distance. [D-39]

**Evidence:** Baritone `GoalXZ.isInGoal` ignores y, while `GoalNear.isInGoal` sums squared x/y/z differences; these support the semantic distinction, not an existing home fence. [GoalXZ][baritone-xz] [GoalNear][baritone-near]

**Consequences/risks:** vertical mining or climbing does not consume the radius; controller checks remain separate from Baritone's chosen goal and do not fence its route. `[VERIFY]` test horizontal boundary crossings and vertical-only movement. [D-39, D-37]

## D-40 — Derive unset home from RayCraft `/home`

**Decision:** the operator reports already having used `/sethome`. When `home=null`, send the allowlisted `/home` once, wait for arrival, record that position as `home`, and print it to the terminal; console `home set` overrides. This is the operator's 2026-10-04 adjudication, not an observed teleport receipt. [D-40, D-29, D-31]

**Alternatives considered:** automatically use first spawn; suspend self-direction until an explicit console `home set`; neither is the selected source. [D-40]

**Evidence:** the operator's existing `/sethome` is the source of the home choice. [D-40] MCPFabric's client send path distinguishes slash commands and sends them through the local connection; it does not verify RayCraft's `/home` plugin behavior. [Command send path][mcp-chat-send]

**Consequences/risks:** never silently substitute spawn/current pre-teleport position for home; home-dependent progression waits for the observed arrival. `[VERIFY]` identify RayCraft's arrival/success/failure signals and test the one-send initialization plus console override. [D-40, D-31, D-37, D-38]

## D-41 — Reset reconnect count after one stable hour

**Decision:** count at most three reconnects, using D-34's configured delays; reset the counter only after one hour of stable connection without a disconnect. A fourth disconnect before that reset stops the agent until console `resume`. This is the operator's 2026-10-04 adjudication. [D-41, D-34, D-24]

**Alternatives considered:** a rolling 60-minute attempt window; rejected in favor of the continuous-stability reset. [D-41]

**Evidence:** Fabric exposes JOIN and DISCONNECT callbacks, providing lifecycle signals for the controller's chosen accounting; the callback API does not implement the counter or moderation classification. [Connection lifecycle][fabric-connection]

**Consequences/risks:** `reconnect.maxPerHour=3` retains its contract spelling but means this reset policy, not a sliding window. The counter and stable timer are in memory only: controller restart resets them; this is not a persistent cross-process rate bound. Ban/staff-kick stop patterns still prohibit retry. `[VERIFY]` exercise three reconnects, a fourth pre-reset disconnect, uninterrupted one-hour stability and console `resume` on RayCraft. [D-41, D-34, D-24, D-38] [controller/run.ts](../controller/run.ts)

## D-42 — Controller owns verified task completion

**Decision:** the mod emits `qc.task` with `{taskId:string,kind:string,state:"at_goal"|"calc_failed"|"canceled"|"lost_control",detail?:string}` only, mapping Baritone PathEvents/process loss of control. The controller alone declares a task done/failed after verifying position/inventory postconditions; `"done"`/`"failed"` are not mod event states. This is the operator's 2026-10-04 adjudication. [D-42, D-09, D-08]

**Alternatives considered:** let the mod declare done/failed; rejected because process deactivation is not a verified skill outcome. [D-42]

**Evidence:** `CustomGoalProcess` calls `onLostControl()` on calculation failure and arrival, and clears its active state there; `MineProcess` compares the desired quantity with existing matching inventory items and can also cancel on failure. [Goal lifecycle][baritone-goal-impl] [Inventory target/failure][baritone-mine-impl] Baritone's enum supplies `AT_GOAL`, `CALC_FAILED` and `CANCELED`, not harness done/failed outcomes. [Path events][baritone-path-events]

**Consequences/risks:** correlate events by `taskId`, reobserve before returning `{ok,summary,observedDelta}`, and never equate `lost_control`/inactivity with success. `[VERIFY]` test arrival, failure, cancellation and inventory-target completion against controller postconditions. [D-42, D-09, D-20, D-38]

## D-43 — Honest self-Q&A scope

**Decision:** when asked, share the model and architecture overview, rules and safety design, code details on request (module/file names, feature explanations and short snippets), and observed live state (goal, last actions/results and latency). Date: 2026-10-04; source: operator build adjudication. [D-43]

**Alternatives considered:** a fixed identity-only answer; omit implementation details. The selected scope permits code discussion on request, not unrestricted disclosure. [D-43, D-44]

**Evidence:** the curated summary and harness search inform the system prompt; each turn includes live controller goal/result/latency and observations. [controller/selfinfo.ts](../controller/selfinfo.ts) [controller/loop.ts](../controller/loop.ts)

**Consequences/risks:** distinguish recorded design/code from observed gameplay; self-Q&A grants no gameplay authority and remains subject to redaction. [D-43, D-44, D-17, D-42]

## D-44 — Code-enforced outgoing redaction

**Decision:** redact network details and secrets/local paths in outgoing chat in code, not merely by prompt: IPv4/IPv6, host:port, hostnames (including Spark/tower names), bridge URL and service ports; credentials/bearer strings, long hex/base64 runs of at least 24 characters, password references, Windows/Unix paths and OS usernames. Home/zone coordinates are not redacted. Date: 2026-10-04; source: operator build adjudication. [D-44]

**Alternatives considered:** prompt-only withholding; also conceal in-game coordinates. Neither was selected. [D-44]

**Evidence:** shared `redact` supplies chat-policy sends before splitting, console `say`, command-tool text and harness-search snippets; repository-relative source references remain discussable. [controller/selfinfo.ts](../controller/selfinfo.ts) [controller/chat-policy.ts](../controller/chat-policy.ts) [controller/run.ts](../controller/run.ts) [controller/skills.ts](../controller/skills.ts)

**Consequences/risks:** replace matches with `[redacted]`; reject a private recipient if redaction would change its name rather than silently redirecting the message. In-game coordinate triples remain available for honest state discussion. [D-44, D-36] [controller/chat-policy.ts](../controller/chat-policy.ts)

## D-45 — About-me summary and `harness_info`

**Decision:** append a short curated about-me summary to the system prompt and add `harness_info(question:string)` for redacted repository-doc/code lookup. D-51 leaves 27 curated tools after removing the timer action. Date: 2026-10-04; source: operator build adjudication. [D-45, D-51]

**Alternatives considered:** preload the whole repository into every turn; rely only on a static summary. The chosen summary plus on-demand search bounds the context. [D-45]

**Evidence:** `ABOUT_ME` lives in `controller/selfinfo.ts`; search covers `docs/*.md` (not evidence), controller/heuristic TypeScript and companion Java, returning the top three snippets within 1,500 characters, prefixed by repo-relative filenames and redacted. `tools.ts` exposes 27 tools under D-51; D-55 permits `harness_info` in the separate chat lane. [controller/selfinfo.ts](../controller/selfinfo.ts) [controller/tools.ts](../controller/tools.ts) [controller/loop.ts](../controller/loop.ts)

**Consequences/risks:** lookup answers harness questions without shell/code execution; the observation, not a source snippet, establishes current gameplay state. [D-45, D-43, D-44, D-09, D-42]

## D-46 — Reserve thinking for console-instruction planning

**Decision:** with `llm.thinking="planning"`, enable thinking only to plan a new console instruction and to replan after a failed tool on that same instruction. Resume, idle/self-goal, chat, death/recovery and successful tool-completion turns run without thinking; a failed-tool replan is the explicit exception, not permission for every completion turn to think. `llm.thinking="off"` remains always off. Date: 2026-10-04; source: operator follow-up adjudication. [D-46, D-21]

**Alternatives considered:** treat resume, self-goal and recovery as planning turns; enable thinking after any failed tool even without a console instruction; always disable thinking. The selected rule preserves deliberate console-task planning without imposing that latency on routine play/conversation. [D-46]

**Evidence:** pre-amendment bench turns classified as thinking-enabled planning took roughly **50–82 seconds**, versus about **3–6 seconds** on ordinary turns, near the thinking request's 90-second deadline. These are sampled bench observations, not a controlled speedup or latency guarantee: examples include 49,678 ms, 81,899 ms and 56,681 ms on resumed planning, and 3,335/4,433 ms on ordinary steps. [bench/logs/2026-10-05T01-31-21-487Z.jsonl](../bench/logs/2026-10-05T01-31-21-487Z.jsonl) [bench/logs/2026-10-05T01-37-15-335Z.jsonl](../bench/logs/2026-10-05T01-37-15-335Z.jsonl) [bench/logs/2026-10-05T01-48-06-684Z.jsonl](../bench/logs/2026-10-05T01-48-06-684Z.jsonl) [controller/llm.ts](../controller/llm.ts)

**Consequences/risks:** routine wakes may still plan actions, but “planning” in the thinking switch means only the two console-instruction cases above. Keep normal/thinking limits 1,024/4,096 completion tokens and deadlines 30/90 seconds; no stale-generation response gains authority from thinking. Raw bench transcripts are local runtime evidence, not public repository artifacts. [D-46, D-20, D-21, D-06] [controller/llm.ts](../controller/llm.ts) [Controller policy](30-controller.md#3-llm-request-and-history-policy)

## D-47 — Reply-only agent chat

**Decision:** remove all control-transition chat and permit agent chat only as a reply. This supersedes D-16's “announce on start/stop” part, not its “explain when asked” rule. D-48 requires incoming addressed messages; D-54 adds five-minute conversation follow-ups without a name, and D-55 confines model chat tools to the parallel chat lane, never the body lane. Date: 2026-10-04; source: operator follow-up adjudication. [D-47, D-16, D-48, D-54, D-55]

**Alternatives considered:** retain activation or human-takeover messages; suppress only console-stop messages; rely on the prompt alone to prevent unprompted chat. None meets the operator's reply-only requirement. [D-47]

**Evidence:** operator text: “remove all chat messages about control being passed between me and the agent. the only time any other players should see something in chat is when i type directly through chat myself or the agent decides to respond in chat to somebody.” [D-47]

**Consequences/risks:** Jared's direct in-game chat and operator-console `say <text>` remain available. The agent never sends unprompted narration, status or control-transition messages. Model `chat_say` / `chat_reply` are allowed only inside a chat-lane request carrying at least one pending `mustReply` or `followUps` entry; all other attempts retain `{ok:false, summary:"chat is only for replying to a message that mentions you"}`. The body lane has neither chat tool. Own echoes, system text and replayed history cannot authorize chat; context alone is insufficient. Replies may explain AI control when asked; allowlisted commands such as `/home` retain their guards. [D-47, D-48, D-54, D-55, D-56, D-57, D-16, D-17, D-18, D-29, D-36]

## D-48 — Addressed-only agent chat

**Decision:** permit replies to incoming non-self player messages containing the account username (`SirWaffleshnoz`, case-insensitive substring), whole-word `jared` (case-insensitive), or classified as a whisper. Use `chat.nicknames=["SirWaffleshnoz"]` and `chat.wholeWords=["jared"]`; the bench substitutes `["QwenBench"]`. Whispers need no name. **Amended by D-54:** follow-ups from the same sender within five minutes of the agent's last reply need no name; each successful reply restarts the window, and the model may ignore lines clearly not meant for it. **Amended by D-56/D-57:** system lines never count, Discord bridge player messages use the normal rules, and history is context only. D-55 routes replies through a parallel chat lane. Otherwise non-addressed chat does not wake either lane. This supersedes D-15 and D-30 and tightens D-47's code gate. Date: 2026-10-04; source: operator follow-up adjudication. [D-48, D-15, D-30, D-47, D-54, D-55, D-56, D-57]

**Alternatives considered:** count whispers only when they contain a name; keep the old nicknames (`waffle`, `bot`, `ai`). Both are rejected: private messages are inherently addressed, and the operator chose only the username and Jared. [D-48]

**Evidence:** operator text: “retune the system so the agent only speaks in chat when the mc username is directly mentioned (also include 'jared' to that list because my name is jared)”. Follow-up ruling: “whispers (/msg to the account) always count as addressing the agent”. [D-48]

**Consequences/risks:** the mod's `mentionsMe` remains authoritative for non-self player mentions; whispers qualify independently, and D-54 adds case-insensitive sender-name follow-up tracking. Only a chat-lane request with pending `mustReply`/`followUps` authorizes model chat tools; other attempts keep `chat is only for replying to a message that mentions you`. Addressing permits conversation, never gameplay instructions. Own echoes, system messages and replayed history cannot authorize a reply; observing recent chat is not sufficient. Direct operator chat, console `say <text>`, silent control transitions and allowlisted commands are unchanged. [D-48, D-54, D-55, D-56, D-57, D-14, D-17, D-36, D-47]

## D-49 — Agent-owned block breaking

**Decision:** the agent may break blocks it placed itself; Jared's and other players' builds receive no new breaking permission. Track successful client block placements through `MultiPlayerGameMode.useItemOn` only while `!QcState.paused()`; this includes controller skills and Baritone pillaring. Placements while paused for any reason are treated as human and are not tracked. This extends D-26. Date: 2026-10-04; source: operator follow-up adjudication. [D-49, D-26, D-11]

**Alternatives considered:** keep strict natural-only protection outside zones; mark the shelter as a free zone. Both were offered and rejected in favor of permission scoped to the agent's own placements. [D-49]

**Evidence:** the operator-observed RayCraft incident: the agent boxed itself inside its own cobblestone shelter, but cobblestone was absent from the natural-block list. Baritone repeatedly logged `Unable to find any path ... deepslate_iron_ore` and emitted `qc.task` `calc_failed` events while the agent remained inside the shelter, roughly every 2 seconds. This incident is not completion of D-38's live acceptance suite. [D-49, D-26, D-38]

**Consequences/risks:** persist entries `{server,dimension,x,y,z,id}` in `<gameDir>/config/qwencraft-placed.json`, load on join, and save changes atomically; `server` is the joined `host:port` and `id` is the namespaced block id observed after placement. Lazily drop entries whose current block id differs; remove a tracked entry on successful break. The guard permits natural blocks, free-zone blocks, or an unchanged tracked placement while the agent is active. `qc.placed.near` exposes nearby tracked placements to observation `ownBlocksNearby`; the model uses `break_block` to dig out. Baritone remains type-based (`blocksToDisallowBreaking`) and cannot route through own non-natural blocks; do not widen its denylist to grant permission over other players' builds. Tracking is not general ownership detection, nor does it remove D-26's natural-type/zone protection limits. [D-49, D-26] [Companion contract](20-companion-mod.md#9-protection-and-baritone-settings) [Controller observation](30-controller.md#5-observation-schema)

Related fixes already shipped in commit `a871634`: controller jobs end after `MAX_PATH_FAILURES=5` consecutive Baritone path-calculation failures; `settings.logger` in `BaritoneFeature` sends status/failure lines to the game log instead of the chat HUD. D-51 adds progress-based stall detection and a larger ore budget; these bound/report failure but do not grant permission to dig through the shelter. [D-51] [controller/skills.ts](../controller/skills.ts) [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java)

## D-50 — Legit branch-mining at the best Y per ore

**Decision:** use legit branch-mining at the selected Y per ore; supersedes D-27. **Amended by D-59:** the controller selects the height and descends before mining when more than 4 blocks above it. Date: 2026-10-04. Operator: “he's been mining for awhile and hasnt found any iron... i think the 'xray' heuristic isnt working properly.” [D-50, D-27, D-59]

**Alternatives considered:** auto-detect the mining policy per server; keep x-ray targeting. Neither is selected. [D-50]

**Evidence:** the orchestrator's read-only RayCraft census at (-1599, 63, 8649), radius 12 over all ore ids, returned 500 ores (truncated) evenly spread across types at y=55–62, including 72 diamond and 40+ deepslate variants; 60/60 sampled iron ores were fully enclosed. Paper anti-xray fake-ore mode makes hidden targets false data until exposed. Baritone v1.20.0 `MineProcess.searchWorld` uses `scanChunkRadius` for untracked blocks; `CachedChunk.BLOCKS_TO_KEEP_TRACK_OF` contains no ores. With `legitMine=true`, it mines visible/reachable ore or branch-mines at `legitMineYLevel` (upstream default -59). These are orchestrator-verified investigation facts, not a completed mining acceptance run. [D-50] [Mining search][baritone-cache-search] [Mining settings][baritone-legit]

**Consequences/risks:** D-59 extends the wire contract to `qc.baritone.mine{blocks,targetCount,y?}` and moves the per-ore height table into controller `oreHeight()`. If every id ends `_ore` or is `minecraft:ancient_debris`, use `legitMine=true`; the controller selects the first mineral's Y and descends first when needed. Any non-ore request uses `legitMine=false` and the loaded-chunk scan, appropriate for real logs/sand/stone data. Startup defaults remain true/16; an omitted RPC `y` uses the player's current block Y, not a mod-owned mineral table. Protection and home bounds remain unchanged; `[VERIFY]` prove iron progress at y=16 and inventory postconditions on RayCraft. [D-50, D-59, D-26, D-37, D-42] [controller/skills.ts](../controller/skills.ts) [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java)

Ore acquisition also bypasses nearby fake-ore scanning/block probing: controller preflight checks/selects the best inventory pickaxe using static harvest tiers, failing explicitly when the required tier is missing. Non-ore scan/protection/harvest checks remain unchanged. [D-50, D-26] [controller/skills.ts](../controller/skills.ts)

## D-51 — No idling except Qwen inference

**Decision:** remove the `wait` tool, leaving exactly 27 tools; active goals immediately wake `continue` instead of parking between actions. Date: 2026-10-04. Operator: “the client shows 'running wait' a lot and gets blown up by creepers frequently... the only reason the agent should sit idle is to wait for qwen inference.” [D-51]

**Alternatives considered:** retain a timer action; depend on a later event to replan. Both allow the observed unnecessary inactivity. [D-51]

**Evidence:** transcript `2026-10-05T04-08-21` showed an interrupted `mine` result discarded as an obsolete generation, followed by the model assuming “task t8 is already running” and selecting 20–30 seconds of inactivity. A no-tool reply with an instruction also stalled until another event. Separately, `MovementHelper.avoidBreaking` called list `contains` per path node over ~1,100 disallowed types within Baritone's 500/2000 ms path timeouts; the live log showed five iron-path blacklists in 10 seconds. [D-51] [controller/loop.ts](../controller/loop.ts) [controller/skills.ts](../controller/skills.ts)

**Consequences/risks:** every body-lane reply must call a tool or finish the goal. A tool owns its task through completion; interrupted, obsolete-generation or no-dispatch results mean STOPPED, not background work. When current/unpaused and an instruction or home exists, no-tool body replies immediately queue `continue`; D-55 runs conversation independently, without interrupting or rescheduling body work. No instruction and no home means the body is `Idle`. A previous no-tool body reply receives the next-action/finish-goal nudge. Ore `mine`/`collect` requests (any id ending `_ore`) receive `min(15 min,max(5 min,count×40 s))`; any job fails with `stalled: no movement or inventory change for 45 s` if neither ≥1-block movement nor target-count change occurs. Keep the five-path-failure exit. The mod's read-only no-break list retains identical contents but uses a HashSet-backed O(1) `contains`, avoiding per-node linear scans without widening guards. [D-51, D-55, D-20, D-26, D-31] [controller/tools.ts](../controller/tools.ts) [controller/skills.ts](../controller/skills.ts) [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java)

## D-52 — Creeper flee reflex

**Decision:** add Java `flee_creeper` ahead of retaliation/eating and below hazard escape. Date: 2026-10-04. Operator: “the client shows 'running wait' a lot and gets blown up by creepers frequently... the only reason the agent should sit idle is to wait for qwen inference.” [D-52, D-32]

**Alternatives considered:** hit creepers; no creeper reflex. Fleeing is the conservative response to the operator's repeated explosions. [D-52]

**Evidence:** the operator reports frequent creeper deaths while the controller stands still; local client-tick reflexes avoid an inference round trip. This observation motivates the reflex, not a claim that its live survival acceptance has passed. [D-52, D-51, D-32]

**Consequences/risks:** a creeper within 5.0 blocks that is fusing (swelling >0 or swell direction >0) or closer than last tick triggers facing horizontally away, forward+sprint, and jump if horizontally blocked. End and release keys at ≥8.0 blocks, disappearance, or 5 seconds. Start emits `qc.reflex{name:"flee_creeper",action:"sprinting away"}`; cancel Baritone every tick while active. Priority is escape > flee_creeper > retaliate > eat. Existing enable/human-takeover rules and controller settling heuristic remain unchanged. `[VERIFY]` exercise trigger, key release, priority and takeover. [D-52, D-11, D-20, D-32] [mod/src/main/java/dev/qwencraft/control/Reflexes.java](../mod/src/main/java/dev/qwencraft/control/Reflexes.java)

## D-53 — Goal-preserving controller restart

**Decision:** reserve console `restart` to reload controller code, config and heuristics while preserving instruction, goal stack and active/paused intent. Date: 2026-10-04. Operator: “add a restart command to the controller that preserves the active goal state but reloads everything else so our code fixes go live without me needing to take down and restart the process manually.” [D-53]

**Alternatives considered:** manual quit/relaunch and goal re-entry; in-process partial module reload. The selected process restart reloads the controller without replaying stale tasks. [D-53, D-20]

**Evidence:** `controller/main.ts` is the supervisor; the former controller entrypoint is `controller/run.ts`. Supervisor relaunches `run.ts` only for `RESTART_EXIT_CODE=75`, exported by `controller/types.ts`. [controller/main.ts](../controller/main.ts) [controller/run.ts](../controller/run.ts) [controller/types.ts](../controller/types.ts)

**Consequences/risks:** write `controller-restart.json` beside `config.paths.notesFile` with `{savedAt:<ms>,instruction:string|null,goals:string[],active:boolean}`, where active is `!operatorPaused`; then perform normal quit cleanup and exit 75. Print `Restarting controller (code, config and heuristics reload; Java mod changes still need a Minecraft restart).` Startup consumes/deletes the file, restores state only within 10 minutes, and uses normal resume/activation automatically if active, printing `Restored after restart: <instruction or 'self-goal'>; resuming.` Otherwise print `Restored after restart (paused).` Malformed/stale files are deleted, ignored and reported. Goal restoration does not restore tasks/history/reconnect accounting. Java changes still require replacing the built mod with Minecraft closed and restarting Minecraft. `[VERIFY]` prove active/paused restoration and stale-file rejection. [D-53, D-11, D-20, D-41] [controller/run.ts](../controller/run.ts) [controller/console.ts](../controller/console.ts)

## D-54 — Five-minute conversation follow-ups

**Decision:** “a conversation stays open for 5 min after the agent's last reply to a player. That player's messages count as addressed without the name. Each reply restarts the window. The model may skip lines clearly not meant for it.” Date: 2026-10-04; source: operator ask-tool ruling, amending D-48. Operator: “seems the most recent chat from alex which carries a previous conversation was ignored because he didnt mention the agent by name.” [D-54, D-48]

**Alternatives considered:** keep requiring a name in every public message; keep a conversation open indefinitely. The ruling selects a bounded five-minute window from the last reply, not from the last incoming message. [D-54]

**Evidence:** the operator reported Alex's continuation being ignored without the agent name. Orchestrator-measured transcripts dated 2026-10-05 show RayCraft player chat rendering as `ray4390 » text` with `kind=player` and a known sender. This supports sender-based follow-up routing, not authenticated identity or a passed acceptance test. [D-54, D-14] [Controller routing](30-controller.md#6-loop-cancellation-and-self-goals)

**Consequences/risks:** match sender names case-insensitively with `now - lastReplyAt(sender) <= 300000`; a successful reply updates the answered senders and explicit `chat_reply` recipient. `mustReply` entries must be answered; `followUps` may be ignored if not directed at the agent. System lines, self echoes and history never open or extend a conversation. Follow-ups expire with the window, and pause blocks the lane. Conversation still cannot supply gameplay authority. [D-54, D-55, D-56, D-57, D-17]

## D-55 — Parallel body and chat lanes

**Decision:** “answer in parallel. A separate chat-only Qwen request answers while the body keeps working (two requests may be in flight).” Date: 2026-10-04; source: operator ask-tool ruling, amending D-15/D-47 scheduling. Operator: “he also seems to occasionally miss (or take a long time) to respond to messages in the chat. we might need to harden that loop and have it check chat history more reliably each turn.” [D-55, D-15, D-47]

**Alternatives considered:** continue planning chat only between body tools; stop mining/navigation to answer; issue a separate request for every line. The ruling selects two lanes, each single-flight, with one body owner. [D-55, D-20]

**Evidence:** orchestrator-measured transcripts dated 2026-10-05 show addressed-message reply latency of **4–137 s**; slow replies arrived during body tools (`mine` 35–137 s, `go_to` 26 s, `craft` 26 s). The pre-amendment `loop.ts` single-flight `pump`/`turn` planned chat only between tools. These observations motivate separation, not a promised latency or live proof of the new lanes. [D-55] [controller/loop.ts](../controller/loop.ts)

**Consequences/risks:** the body lane uses the registry minus `chat_say`/`chat_reply`, retains `recentChat` only as context, and receives no pending reply list. The chat lane uses only `chat_say`, `chat_reply`, `harness_info`, `observe`, thinking off, a 30-second request deadline and up to three tool rounds in its own history. Its input is `{mustReply,followUps,recentChat,live}`; pending entries arriving during a turn run next immediately. Chat tools need at least one addressed/follow-up entry; the D-47 rejection text stays exact. Any pause blocks chat; pending addressed entries retain their 120-second expiry. Single-flight is per lane, not global; shared Spark capacity and mod send limits still apply. [D-55, D-54, D-47, D-18, D-20] [Chat lane contract](30-controller.md#6-loop-cancellation-and-self-goals)

**Orchestrator implementation amendment:** retry unanswered `mustReply` after five seconds with a nudge, at most twice per entry, then log `Unanswered chat dropped: <sender>: <text>`; consume ignored follow-ups after the turn. Live heuristic reply decisions route into the model chat lane rather than direct sends. The finite retries do not change the original reply-only or terminal-authority rulings. [D-55, D-54, D-25, D-17] [controller/loop.ts](../controller/loop.ts) [controller/run.ts](../controller/run.ts)

## D-56 — Discord bridge player chat; system context only

**Decision:** “system lines (advancements, joins, deaths) are context only. `Discord • <name> » <text>` counts as a player message from <name>.” Date: 2026-10-04; source: operator ask-tool ruling for the missed/slow-chat report quoted in D-55. This amends D-48 classification, not terminal-only authority. [D-56, D-48, D-55, D-17]

**Alternatives considered:** count every username-bearing system line as addressed; leave Discord bridge conversation classified as system. Both conflict with the ruling. [D-56]

**Evidence:** orchestrator-measured transcripts dated 2026-10-05 show `SirWaffleshnoz has made the advancement [...]` and `SirWaffleshnoz joined the game` arriving as `kind=system`, `mentionsMe=true`, then entering `unanswered`. Discord bridge lines arrived as system too: `Discord • Sam » Hey jared's ai`. Ordinary RayCraft player chat renders as `ray4390 » text` with a known sender. [D-56] [Companion chat contract](20-companion-mod.md#6-chat-hooks-and-sending)

**Consequences/risks:** only non-whisper GAME/system text matching `^Discord \u2022 (\S+) \u00bb (.*)$` becomes `kind=player`, with sender name group 1, null UUID, `signed=false`, unchanged text and normal nickname matching against group 2. All remaining system events have `mentionsMe=false` and are context only, even when they name the agent. Whisper detection and ordinary player chat stay unchanged. A parsed display name is not authenticated identity or gameplay permission. [D-56, D-14, D-17]

## D-57 — Startup and join history never prompt replies

**Decision:** “chat arriving in the first 5 s after joining is history (context only).” Date: 2026-10-04; source: operator ask-tool ruling for the missed/slow-chat report quoted in D-55. Startup catch-up is also context only, not a new addressed message. [D-57, D-55]

**Alternatives considered:** reply to all recovered mentions; deduplicate by message text; infer which replayed lines are new. The selected startup watermark and join grace preserve context without speculative replies. [D-57, D-14]

**Evidence:** orchestrator-measured transcripts dated 2026-10-05 show 20+ old messages delivered in one burst at rejoin **03:45:51** and controller start **03:24:13**, from server replay plus `events.getRecent` catch-up, and treated as new mentions. [D-57] [controller/run.ts](../controller/run.ts) [Event recovery](30-controller.md#2-bridge-client-and-event-recovery)

**Consequences/risks:** after setting up the event stream, read the highest current event ID once using `events.getRecent {limit:1}`; `qc.chat` IDs at or below it are history. Each `qc.join` sets `graceUntil=Date.now()+5000`; chat processed before that time is history. Route either case through `loop.wake('chat history', message)` only, never reply routing. History enters `recentChat` but creates no unanswered/follow-up entry and runs neither lane. New conversation during the five-second grace is deliberately context-only too; later fresh mentions/follow-ups use D-54/D-55. [D-57, D-54, D-55]

## D-58 — Inventory-chests heuristic

**Decision:** ship `heuristics/inventory-chests.ts` at priority 50 to preserve usable inventory space through own-chest storage rather than dropping items. Date: 2026-10-04. Operator: “we also need a new heuristic which has the agent use chests more appropriately. his inventory gets full and he cant craft and then gets stuck in a drop loop because he keeps dropping and picking stuff back up.” [D-58, D-25] [heuristics/inventory-chests.ts](../heuristics/inventory-chests.ts)

**Alternatives considered:** keep dropping surplus at the agent's feet; give only a generic inventory hint. Dropping caused immediate pickup, and the observation lacked the free-slot count needed to distinguish inventory pressure. [D-58]

**Evidence:** transcript `2026-10-05T04-08-21` recorded only three `drop` calls: **64 cobblestone, 64 cobblestone and 35 dirt**, all picked back up. It had no free-slot count; it does not independently prove that the inventory was full. In the orchestrator's full-inventory bench run, the model set `Free inventory space (chest), then mine 6 raw iron` and tried to place its crafting table to free a slot, with **no drops**. This proves the observed planning response, not a completed chest-storage workflow or RayCraft acceptance. [D-58, D-38] [Bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

**Consequences/risks:** `controller/observe.ts` exposes `inventory.freeSlots = 36 − listed hotbar+main stacks`; `player.getInventory` omits empty slots. At `freeSlots <= 4`, hints prioritize `chest_deposit` of bulk blocks into **OWN chests only**, discovered from chest entries in `ownBlocksNearby` and notes places with `kind:"chest"`. With no own chest, craft/place/remember one; at 0 free slots, first place a carried block to make room. Keep tools, weapons, armour, food, torches and current-goal materials; never use other players' chests. `onPlanProposed` vetoes `drop` unless goal text contains the whole word `drop` (case-insensitive), preserving explicit operator requests. Storage advice remains advisory, not general chest ownership detection. [D-58, D-25, D-49] [heuristics/inventory-chests.ts](../heuristics/inventory-chests.ts) [controller/observe.ts](../controller/observe.ts) [controller/test/inventory-heuristic.test.ts](../controller/test/inventory-heuristic.test.ts)

## D-59 — Dig down before legit branch-mining

**Decision:** amend D-50: the controller owns the per-ore height policy and descends before starting legit branch-mining when the player is more than 4 blocks above the selected height. Date: 2026-10-04; source: orchestrator's verified mining investigation and implementation amendment. [D-59, D-50] [controller/skills.ts](../controller/skills.ts)

**Alternatives considered:** set only `legitMineYLevel` and expect Baritone to descend; retain a duplicate mineral table in the mod. The first produced surface travel, and the second would split height policy across two owners. [D-59]

**Evidence:** Baritone v1.20.0 legit mode uses `GoalRunAway(1, legitMineYLevel, branchPoint)` from wherever mining starts, rather than first navigating straight down. The orchestrator's bench observed **265 blocks of surface travel at y=64**. Before this amendment, another bench run dug from y≈63 to y=31 and collected **3 raw iron in 40 s**; that progress is not proof of descent to the chosen y=16. [D-59, D-50] [MineProcess.java, v1.20.0, L195–221](https://github.com/cabaletta/baritone/blob/v1.20.0/src/main/java/baritone/process/MineProcess.java#L195-L221) [Bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

**Consequences/risks:** controller `oreHeight()` selects coal 96, copper 48, iron 16, gold -16, redstone -58, diamond -58 and lapis 0; deepslate variants share their mineral, and other ores use current height. If the player is more than 4 blocks above `oreY`, run `qc.baritone.goto {x,y:oreY,z}` at current x/z first, then `qc.baritone.mine {blocks,targetCount,y:oreY}`. The RPC's optional `y` is the branch-mining height; omitted `y` defaults to the player's current block Y. `BaritoneFeature.java` no longer owns a per-ore Y table. This is not an instruction to ascend when below the selected Y, and does not widen protection or home bounds. `[VERIFY]` prove the amended descent/mining sequence and actual inventory progress on RayCraft. [D-59, D-26, D-37, D-42] [controller/skills.ts](../controller/skills.ts) [mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java](../mod/src/main/java/dev/qwencraft/baritone/BaritoneFeature.java) [RPC contract](20-companion-mod.md#4-rpc-contract)

## D-60 — Strike-first combat with sword management and player retaliation

**Decision:** replace the reactive "fight back after damage" reflex with strike-first combat. Operator (2026-10-04): "the model should always keep the diamond sword it has in the hotbar and instantly switch to it when mobs approach. it should reflexively hit mobs with the sword … reflexes should be fast enough to prevent that. we also need a player combat heuristic - if another player hits the agent then he should fight back." Follow-ups: "combat should also be based on the 'closest first' principle"; "the agent will need to proactively hunt down the skeleton iff it is able to land an arrow shot." Implementation summary in [20-companion-mod.md](20-companion-mod.md) (Combat row). Supersedes the D-32 "fight back" row and amends D-17 (players are fought only after they hit first). [D-60, D-32, D-17]

**Alternatives considered:** keep retaliation-only; hit creepers too (the operator chose flight in D-52, kept). The operator's premise that combat makes damage "definitionally impossible" was challenged: sword cooldown (~0.6 s), 0.5 s invulnerability frames, simultaneous mobs, arrows and explosions limit any melee reflex, and other players have reach, shields, bows and gear. Instant snap aim is also the classic KillAura signature that anti-cheat plugins flag ([Baritone #4018](https://github.com/cabaletta/baritone/issues/4018)). [D-60]

**Evidence:** bench, same scenario (2 zombies, husk, skeleton at night): the reactive version took 7 hits and the skeleton survived 30 s at 7–13 blocks. The first strike-first version took 2 melee hits but never engaged the skeleton (4 arrow hits). The final version, with 15-block ranged hunting and recharge back-pedalling, killed all four in 8.4 s with 2 hits (one opening zombie hit, one point-blank arrow), sword selected throughout, nearest first. Player retaliation is not live-tested (the bench has one player). [Bench results](50-install-and-verification.md#local-bench--observed-2026-10-04)

**Consequences/risks:** combat preempts tasks often; the controller replans after each fight. Higher anti-cheat exposure on RayCraft. Remaining damage sources: arrows while closing in, several mobs at once, explosions. A shield (offhand, raised while recharging) would be the next lever and is not implemented. [D-60, D-02]

## Tensions accepted by the operator

| Tension | Accepted consequence and boundary |
|---|---|
| Third-party main-account testing + legit ore mining + parkour [D-02, D-50, D-28] | `[INFERENCE]` automation still has anti-cheat/ban exposure; legit mining avoids fake hidden-ore targets, not the need for owner approval or actual plugin acceptance. [Historical Matrix report][baritone-891] [Parkour default][baritone-parkour] [Automation warning][litematica] |
| Auto-reconnect versus moderation-aware bounds [D-24, D-34, D-41] | Recovery is not unlimited: configured delays permit at most three reconnects, reset only after one hour without disconnect; a fourth pre-reset disconnect requires console `resume`, and ban/staff-kick patterns prohibit retry. Callback availability does not identify moderation intent. [D-41, D-34] [Connection callbacks][fabric-connection] |
| Addressed conversation versus terminal-only task authority [D-48, D-54, D-55, D-17, D-05] | Mentions, whispers and bounded unnamed follow-ups remain conversational data; the chat lane has no gameplay tools. Non-addressed lines outside an open window, system lines and history are context only, and metadata may be absent. Mindcraft's code-enabled public-server injection warning is a risk precedent, not a tested qwencraft exploit. [D-56, D-57] [Identity limits][fabric-chat] [Code-enabled warning][mindcraft-readme] |
| Convenience versus profile isolation [D-12] | `[INFERENCE]` a shared `.minecraft` gameDir also shares `mods/` with other Fabric profiles using that directory; inspect profile configuration before adding the stack. [Observed gameDir](evidence/client-process.txt) [Installer profile][installer-profile] |
| Movement defaults versus explicit parkour override [D-28] | Keep sprint/place/break defaults, but record parkour as an intentional false→true override rather than calling it an upstream default. [Basic defaults][baritone-basic] [Parkour defaults][baritone-parkour] |
| Home convenience versus a proven arrival [D-31, D-37, D-39, D-40] | The operator's existing `/sethome` settles the source, not teleport success: derive unset home once through `/home`, print the observed arrival and allow console override; horizontal radius remains controller-only, with unfenced Baritone paths. [D-39, D-40, D-37] |
| Process lifecycle versus task success [D-08, D-09, D-42] | `qc.task` reports only at_goal/calc_failed/canceled/lost_control; controller postconditions alone decide done/failed because arrival and calculation failure both deactivate the goal process. [D-42] [Goal lifecycle][baritone-goal-impl] |

[mcp-limits]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/docs/AGENT.md#L76-L108
[mcp-memory]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/docs/AGENT.md#L3-L32
[mcp-runtime]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/mcp-server/src/agent/runtime.ts#L44-L57
[mcp-config]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/config/McpConfig.java#L13-L76
[mcp-http]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/bridge/HttpBridgeServer.java#L92-L134
[mcp-control]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/ControlHandlers.java#L16-L90
[mcp-chat-hook]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/fabric/FabricClientEntrypoint.java#L18-L28
[mcp-chat-send]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/ClientChatHandlers.java#L9-L29
[mcp-events]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/main/java/dev/mcpfabric/events/EventBus.java#L18-L70
[mcp-vision]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/src/client/java/dev/mcpfabric/client/handlers/VisionHandlers.java#L170-L182
[mcp-license]: https://github.com/Etoryx/mcpfabric/blob/990490791a0a38273ce28c0b15f2e90448347e2d/LICENSE
[mcp-33]: https://github.com/Etoryx/mcpfabric/issues/33
[baritone-primary]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/IBaritoneProvider.java#L40-L52
[baritone-goal]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/ICustomGoalProcess.java#L46-L54
[baritone-mine]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IMineProcess.java#L30-L107
[baritone-mine-impl]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/process/MineProcess.java#L70-L100
[baritone-follow]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IFollowProcess.java#L30-L58
[baritone-explore]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/process/IExploreProcess.java#L22-L27
[baritone-xz]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalXZ.java#L52-L65
[baritone-near]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/pathing/goals/GoalNear.java#L35-L54
[baritone-cancel]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/behavior/IPathingBehavior.java#L74-L105
[baritone-basic]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L59-L78
[baritone-protect]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L247-L259
[baritone-legit]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L1188-L1192
[baritone-parkour]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L351-L369
[baritone-chat]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L680-L689
[baritone-891]: https://github.com/cabaletta/baritone/issues/891
[fabric-properties]: https://github.com/FabricMC/fabric-example-mod/blob/44465cb0eb83932c72ece5934d32ddfc758802ed/gradle.properties#L1-L17
[fabric-build]: https://github.com/FabricMC/fabric-example-mod/blob/44465cb0eb83932c72ece5934d32ddfc758802ed/build.gradle#L1-L55
[fabric-install]: https://github.com/FabricMC/fabric-docs/blob/f17bf08e377fc572169fee8df71bbef95628ed2d/players/installing-fabric/windows.md#L24-L38
[installer-profile]: https://github.com/FabricMC/fabric-installer/blob/6e7d1acd6a951a19a323060ac955f5e7bc51e3ce/src/main/java/net/fabricmc/installer/client/ProfileInstaller.java#L71-L105
[fabric-chat]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-message-api-v1/src/client/java/net/fabricmc/fabric/api/client/message/v1/ClientReceiveMessageEvents.java#L204-L234
[fabric-tick]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-lifecycle-events-v1/src/client/java/net/fabricmc/fabric/api/client/event/lifecycle/v1/ClientTickEvents.java#L29-L75
[fabric-connection]: https://github.com/FabricMC/fabric-api/blob/84831249df47bd923b48186d169bc0d8501b547b/fabric-networking-api-v1/src/client/java/net/fabricmc/fabric/api/client/networking/v1/ClientPlayConnectionEvents.java#L42-L81
[mindcraft-actions]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/commands/actions.js
[mindcraft-manager]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/action_manager.js#L26-L112
[mindcraft-modes]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/modes.js#L24-L304
[mindcraft-history]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/history.js#L19-L95
[mindcraft-self]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/src/agent/self_prompter.js#L55-L145
[mindcraft-readme]: https://github.com/mindcraft-bots/mindcraft/blob/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101/README.md
[vllm-parser]: https://github.com/vllm-project/vllm/blob/ced6857afa0ea7b2e3f0846a62e1394e90f15607/vllm/parser/qwen3.py#L179-L206
[mineflayer]: https://github.com/PrismarineJS/mineflayer/releases/tag/4.39.0
[viaproxy]: https://github.com/ViaVersion/ViaProxy/releases/tag/v3.4.13
[litematica]: https://modrinth.com/mod/litematica
[paper-properties]: https://docs.papermc.io/paper/reference/server-properties/
[paper-spigot]: https://docs.papermc.io/paper/reference/spigot-configuration/
[model-card]: https://huggingface.co/nvidia/Qwen3.8-Flash-Next-NVFP4
[baritone-prefix]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/Settings.java#L835-L844
[baritone-command]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/command/ExampleBaritoneControl.java#L61-L74
[mineflayer-support]: https://github.com/PrismarineJS/mineflayer/blob/c168635cf2f6602069fc5e408bec864702335581/docs/README.md#L20
[baritone-goal-impl]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/process/CustomGoalProcess.java#L98-L134
[baritone-path-events]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/api/java/baritone/api/event/events/PathEvent.java#L20-L32
[baritone-cache-search]: https://github.com/cabaletta/baritone/blob/25111daedf1d59e6a8dfb5a3e61885cdb8d953df/src/main/java/baritone/process/MineProcess.java#L359-L387
