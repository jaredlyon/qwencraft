# qwencraft — design documentation

Phase 1: a harness that lets the Qwen model served on the DGX Spark play Minecraft through Jared's own Minecraft client on the tower. The model plays on the server that client is connected to, takes instructions from a tower terminal, retains chat as context and answers only incoming non-self addressed messages (username substring, whole-word Jared, or any whisper), and can be extended with user-written heuristics [D-00, D-01, D-05, D-48, D-25]. The house/blueprint architecture is out of scope until a later phase [D-00].

Status: Phase-1 harness implemented; bench-verified; RayCraft acceptance pending. See the [repository README](../README.md) for build/run entrypoints and [local bench results](50-install-and-verification.md#local-bench--observed-2026-10-04); decisions and build amendments were recorded on 2026-10-04 in [00-decisions.md](00-decisions.md). [D-00, D-38]

Other players see chat only when Jared types in-game himself (or uses unchanged operator-console `say <text>`) or the agent replies to an incoming non-self addressed message: `SirWaffleshnoz` (case-insensitive substring), `jared` (case-insensitive whole word), or any whisper. Activation and control changes are silent. Code rejects the agent's chat tools with `chat is only for replying to a message that mentions you` unless the current request contains an incoming non-self `player` message with `mentionsMe=true` or a `whisper` in observation `recentChat` or pending `mustReply`. Non-addressed chat is context only for the next turn and does not wake the model; allowlisted commands such as `/home` remain separate. [D-48](00-decisions.md#d-48--addressed-only-agent-chat) [D-47](00-decisions.md#d-47--reply-only-agent-chat)

The active agent may break its own tracked, unchanged placements; all placements during any pause are human and not tracked. `qc.placed.near` feeds observation `ownBlocksNearby`, and the model digs out of its own shelter with `break_block` because Baritone remains type-based and cannot route through own non-natural blocks. The existing natural-block/free-zone policy is otherwise unchanged. [D-49](00-decisions.md#d-49--agent-owned-block-breaking) · [Protection contract](20-companion-mod.md#9-protection-and-baritone-settings)

## Documents

| File | Contents |
|---|---|
| [00-decisions.md](00-decisions.md) | Decision log D-00…D-49: what was chosen, which alternatives were considered, the evidence, and the tensions the operator accepted |
| [10-architecture.md](10-architecture.md) | Ground truth, process topology, layering, agent loop, latency budget, failure domains |
| [20-companion-mod.md](20-companion-mod.md) | The `qwencraft` Fabric mod: Baritone RPCs, chat hook, stop controls, reflexes, protect guard, HUD |
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
