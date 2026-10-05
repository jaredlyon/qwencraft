# qwencraft — design documentation

Phase 1: Qwen on the DGX Spark plays through Jared's visible client on the tower, taking instructions only from the tower terminal. The controller has a gameplay body lane and a parallel conversation lane: player mentions, whispers and eligible five-minute follow-ups can receive replies; other chat, system lines and replayed history are context only. User-written heuristics remain supported. House/blueprint architecture stays out of scope. [D-00, D-01, D-05, D-25, D-48, D-54, D-55, D-56, D-57]

Status: Phase-1 harness implemented; bench-verified; RayCraft acceptance pending. See the [repository README](../README.md) for build/run entrypoints and [local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04); decisions and build amendments were recorded on 2026-10-04 in [00-decisions.md](00-decisions.md). [D-00, D-38]

Other players see only Jared's direct in-game/console `say <text>` chat or replies to fresh non-self player mentions (`SirWaffleshnoz` substring, whole-word `jared`, case-insensitive), whispers or unnamed follow-ups within five minutes of the agent's last reply to that sender. Every reply restarts the window; clearly unrelated follow-ups may be ignored. Model chat tools exist only in the separate chat lane, require pending `mustReply`/`followUps`, and otherwise retain `chat is only for replying to a message that mentions you`; the body lane has no chat tools. Non-whisper `Discord • <name> » <text>` is player chat with a parsed display name, not authenticated identity. Remaining system lines, startup catch-up and five-second join replay never invite replies. Each lane is single-flight, so up to two Qwen requests may overlap; pause blocks chat too. Activation/control transitions stay silent and allowlisted commands remain separate. [D-47, D-48, D-54, D-55, D-56, D-57](00-decisions.md) · [Chat policy](40-chat-and-safety.md)

The active agent may break its own tracked, unchanged placements; all placements during any pause are human and not tracked. `qc.placed.near` feeds observation `ownBlocksNearby`, and the model digs out of its own shelter with `break_block` because Baritone remains type-based and cannot route through own non-natural blocks. The existing natural-block/free-zone policy is otherwise unchanged. [D-49](00-decisions.md#d-49--agent-owned-block-breaking) · [Protection contract](20-companion-mod.md#9-protection-and-baritone-settings)

Current fix-wave policy: 28 curated tools (including `repair_tool`), immediate `continue` for actionable instruction/home goals, controller-owned per-ore height selection with descent before legit mining when more than 4 blocks above it (iron y=16), and Java `flee_creeper` below hazard escape. Shipped heuristics advise own-chest storage at ≤4 free slots, check tool durability to plan repair/replacement, and reserve one table/furnace; newly placed crafting/smelting stations are picked up after use, or left placed with a location note on recovery failure. **D-61/D-62 bench and RayCraft checks remain pending.** Launch `main.ts` (supervisor) → `run.ts` (controller); console `restart` preserves goals and active intent while reloading code/config/heuristics. Java changes still require Minecraft restart. Earlier bench results include parallel private chat during mining, creeper flee, chest conservation and inventory-pressure planning; restart restoration/resumption was also exercised on bench and live, without claiming the full RayCraft acceptance suite. [D-50…D-53](00-decisions.md#d-50--legit-branch-mining-at-the-best-y-per-ore) · [D-58/D-59](00-decisions.md#d-58--inventory-chests-heuristic) · [D-61/D-62](00-decisions.md#d-61--tool-durability-planning-and-anvil-repair) · [Verification](50-install-and-verification.md)

## Documents

| File | Contents |
|---|---|
| [00-decisions.md](00-decisions.md) | Decision log D-00…D-63: choices, alternatives, evidence and accepted tensions; D-27 superseded by D-50, amended by D-59; D-54…D-57 amend chat scheduling/classification; D-58 adds inventory-chests, D-61 adds tool durability/anvil repair, D-62 adds the portable station kit |
| [10-architecture.md](10-architecture.md) | Ground truth, process topology, layering, agent loop, latency budget, failure domains |
| [20-companion-mod.md](20-companion-mod.md) | The `qwencraft` Fabric mod: Baritone RPCs, inventory durability/anvil-state RPCs, chat hook, stop controls, reflexes, protect guard, HUD |
| [30-controller.md](30-controller.md) | The TypeScript controller: bridge client, LLM client, curated tools, observations, heuristics API, memory, console |
| [40-chat-and-safety.md](40-chat-and-safety.md) | Chat ingestion and reply policy, AI disclosure, safety gates, stop-control precedence, risk register |
| [50-install-and-verification.md](50-install-and-verification.md) | Toolchain, client install, bring-up on RayCraft, phase-1 acceptance tests (D-38) |
| [references.md](references.md) | Every external source, pinned to a SHA or tag, plus the local evidence files |
| [evidence/](evidence/) | Raw command output captured on 2026-10-04 (client, server ping, vLLM endpoint, tower toolchain) |

## Citation conventions

- External sources are linked at a pinned commit SHA or release tag, with `#Lx-Ly` line anchors where possible.
- `evidence/<file>` points to captured command output in this repo. Secrets are redacted.
- `[D-xx]` refers to an operator decision in [00-decisions.md](00-decisions.md).
- `[INFERENCE]` marks a design judgement that no source verifies.
- `[VERIFY]` marks an outstanding build or live RayCraft check. Resolved build details cite repo-relative implementation paths.
