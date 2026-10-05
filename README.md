# qwencraft

A phase-1 Minecraft 26.3 harness: Qwen3.8-Flash-Next on a DGX Spark plans through a TypeScript controller, while a Fabric companion mod, MCPFabric and Baritone drive Jared's visible client. Instructions come only from the local terminal; Minecraft chat is conversation, including honest AI/self-Q&A. House/blueprint architecture is deferred. [D-00, D-01, D-05, D-17, D-43](docs/00-decisions.md) · [controller/selfinfo.ts](controller/selfinfo.ts)

**Status: Phase-1 harness implemented; bench-verified; RayCraft acceptance pending.** The local bench proved chat/private replies, four-log mining, basic crafting, idle survival steps, console/lease stops and guards/hot reload—not the full live acceptance suite. [Bench results](docs/50-install-and-verification.md#local-bench--observed-2026-10-04)

## Layout

- `mod/` — Java 25 Fabric companion: control/reflexes, guards, Baritone RPCs and HUD. [mod/src/main/java/dev/qwencraft/QwencraftClient.java](mod/src/main/java/dev/qwencraft/QwencraftClient.java)
- `controller/` — Node 24 erasable TypeScript planner, 28 curated tools, chat, memory and console. [controller/main.ts](controller/main.ts) · [controller/tools.ts](controller/tools.ts)
- `heuristics/` — trusted operator-written, hot-reloaded hooks. [Authoring guide](heuristics/README.md)
- `bench/` — disposable loopback Paper server, RCON/RPC helpers and bench config. [Bench guide](bench/README.md)
- `docs/` — cited design/decision register and pending live installation/acceptance. [Index](docs/README.md)
- `vendor/` — SHA-256 manifest and fetch tooling for pinned MCPFabric/Baritone/Fabric API JARs. This repository is being published **PUBLIC**: JARs are not committed; run `node vendor/fetch.ts` to download and verify them. Global IPv6 addresses in `docs/evidence/tower-network.txt` are redacted; tokens/runtime logs remain private. [vendor/SHA256SUMS](vendor/SHA256SUMS) · [Network evidence](docs/evidence/tower-network.txt) · [D-06](docs/00-decisions.md#d-06--new-repository)

## Build the mod

Fetch vendor JARs first from the repository root with `node vendor/fetch.ts`; downloads are SHA-256 checked against the pinned manifest. Then build in PowerShell with the local JDK 25 path below. [vendor/SHA256SUMS](vendor/SHA256SUMS) · [mod/build.gradle](mod/build.gradle) · [bench/README.md](bench/README.md)

```powershell
$env:JAVA_HOME = 'D:/qwencraft/.tools/jdk-25.0.4.1+1'
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
Set-Location D:/qwencraft/mod
.\gradlew.bat build
```

## Run the local bench

Follow [bench/README.md](bench/README.md) for first-launch bridge configuration and all terminal/shutdown steps. Read and accept the Minecraft EULA before launching Paper; close the real client to free the bridge port, and never expose the offline bench to the network. [bench/server.ts](bench/server.ts)

1. Repository root: `node bench/server.ts`; wait for Paper's `Done`.
2. Another terminal at root: `node bench/rcon.ts "op QwenBench"`.
3. With JDK 25 set, under `mod/`: `.\gradlew.bat runClient`. QuickPlay uses `QwenBench`; set **`onboardAccessibility:false` in `mod/run/options.txt` with the dev client closed** to avoid first-run onboarding blocking auto-join. [mod/build.gradle](mod/build.gradle) · [QuickPlay note](docs/50-install-and-verification.md#local-bench--observed-2026-10-04)
4. After configuring the dev bridge safely, under `controller/`: `node main.ts --config ../bench/qwencraft.bench.json`. It starts paused; enter `resume`, then `home set` when vanilla's unavailable `/home` requests it. Node ≥24.12 runs `.ts` directly; no runtime npm dependencies or compile step. [controller/package.json](controller/package.json) · [controller/main.ts](controller/main.ts)

Thinking is reserved for planning a new console instruction and a replan after a failed tool on that instruction; resume, idle/self-goal, chat, death/recovery and successful tool-completion turns run without thinking. Earlier bench thinking turns took about 50–82 s versus 3–6 s on ordinary steps, near the 90-second thinking deadline. [D-46](docs/00-decisions.md#d-46--reserve-thinking-for-console-instruction-planning)

Write a default-export heuristic in `heuristics/*.ts`; see [heuristics/README.md](heuristics/README.md) and [example-food.ts](heuristics/example-food.ts) for hooks, priority, vetoes and hot reload. Plugins are trusted local code, not a sandbox for chat/model-generated code. [D-25](docs/00-decisions.md#d-25--user-heuristic-hooks-and-hot-reload)

## Safety and pending live install

F8/manual takeover relinquish controls **and disable Java reflexes**. Console `stop`/`quit` and the 3-second dead-man lease cancel planned work but leave survival reflexes active; use a safe full-food fixture for those checks. **F8/manual takeover still require operator physical-input testing.** [Stop semantics](docs/40-chat-and-safety.md#6-stop-precedence-and-residual-reflexes) · [Bench scope](docs/50-install-and-verification.md#local-bench--observed-2026-10-04)

Other players see chat only when Jared types in-game himself (or uses unchanged operator-console `say <text>`) or the agent replies to another player's message. Activation and control changes are silent; no unprompted narration/status. Code rejects `chat_say` / `chat_reply` unless the current request contains an incoming non-self `player`/`whisper` message in observation `recentChat` or pending `mustReply`. AI explanation when asked and allowlisted commands such as `/home` remain allowed. [D-47](docs/00-decisions.md#d-47--reply-only-agent-chat)

Mod action-path guards enforce natural-block/free-zone breaking, chat pacing/length, command allowlist and `#` rejection; controller checks additionally enforce a horizontal home radius and code-redact outgoing network/secrets/local paths, not game coordinates. Guards are not ownership detection or an anti-cheat guarantee. [Safety design](docs/40-chat-and-safety.md) · [D-44](docs/00-decisions.md#d-44--code-enforced-outgoing-redaction)

**Real-client installation approved by the operator on 2026-10-04; completion and RayCraft acceptance still pending.** The default natural-block list is accepted for RayCraft, not an ownership detector or anti-cheat guarantee. Back up the shared `.minecraft` and launcher/mod/config state; install the selected Fabric profile and four runtime mods with Minecraft closed; apply safe bridge settings preserving its private token. Confirm server-owner/rule permission separately before supervised automated acceptance (all D-38 tests, including physical stops and 30-minute survival). [D-12, D-26](docs/00-decisions.md) · [Live-install and verification runbook](docs/50-install-and-verification.md)
