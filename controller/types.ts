/** AbortSignal reason used when a Java reflex took the body: skills must stop work but not send body-release RPCs. */
export const REFLEX_OWNS_BODY = "reflex-owns-body";

// Shared cross-module contracts for the qwencraft controller. Erasable TypeScript only (Node type stripping):
// no enums, namespaces, parameter properties or decorators anywhere in controller/ or heuristics/.

export type Vec3 = [number, number, number];

// ---------- config (qwencraft.config.json; keys per docs/30-controller.md §1) ----------
export interface Zone { name: string; min: Vec3; max: Vec3 }
export interface Config {
  llm: { baseUrl: string; model: string; thinking: "planning" | "off" | "on" };
  chat: { nicknames: string[]; wholeWords: string[]; minIntervalMs: number; maxLen: number; maxLinesPerReply: number };
  commands: { allowlist: string[] };
  protect: { naturalBlocks: string[]; zones: Zone[] };
  home: Vec3 | null;
  selfGoal: { radius: number };
  reflex: { eatAtFood: number };
  reconnect: { maxPerHour: number; backoffMs: number[]; stopPatterns: string[] };
  lease: { ttlMs: number; intervalMs: number };
  server: { host: string; port: number };
  // Implementation keys (not operator decisions): where to find the bridge and its token, and where to write logs.
  bridge: { url: string; configPath: string };
  paths: { heuristicsDir: string; notesFile: string; transcriptDir: string };
}

// ---------- bridge (MCPFabric HTTP, POST /rpc {method,params}) ----------
export class BridgeError extends Error {
  code: string;
  data: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
export interface RpcOptions { signal?: AbortSignal; timeoutMs?: number }
export interface Bridge {
  /** Resolves `result` on {ok:true} (unchecked: caller supplies T and narrows); throws BridgeError on {ok:false} or transport failure (code "transport"). */
  rpc<T = unknown>(method: string, params?: Record<string, unknown>, opts?: RpcOptions): Promise<T>;
  health(): Promise<boolean>;
}

// ---------- events (SSE /events + events.getRecent catch-up) ----------
export interface GameEvent { id: number; type: string; gameTime: number; data: unknown }
export interface Events {
  /** Subscribe to one event type, or "*" for all. Returns an unsubscribe function. Delivery is deduplicated by id. */
  on(type: string, fn: (e: GameEvent) => void): () => void;
  /** Resolves with the first matching event after now, or null on timeout/abort. */
  next(type: string, pred: (e: GameEvent) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<GameEvent | null>;
}

// ---------- mod event payloads ----------
export type PauseReason = "hotkey" | "manual_input" | "lease_expired" | "console";
export interface ChatEvent {
  id: number; kind: "player" | "system" | "whisper"; senderUuid: string | null; senderName: string | null;
  text: string; signed: boolean; mentionsMe: boolean; self: boolean;
}
export type TaskState = "at_goal" | "calc_failed" | "canceled" | "lost_control";

// ---------- heuristics API (binding, docs/30-controller.md §7) ----------
export type Observation = Record<string, unknown>;
export interface Ctx { config: Readonly<Record<string, unknown>>; notes: Readonly<Record<string, unknown>>; log(msg: string): void; now(): number }
export interface ToolCall { name: string; args: Record<string, unknown> }
export interface TickSnapshot { health: number; food: number; pos: Vec3; hostilesNear: number; paused: boolean }
export interface ReflexIntent { call: ToolCall; reason: string }
export type ChatDecision = { reply: string } | { ignore: true } | { toModel: true };
export interface Heuristic {
  name: string;
  priority?: number;
  onObservation?(obs: Observation, ctx: Ctx): string[] | void;
  onPlanProposed?(call: ToolCall, obs: Observation, ctx: Ctx): ToolCall | { veto: string } | void;
  onTick?(snap: TickSnapshot, ctx: Ctx): ReflexIntent | void;
  onChat?(msg: ChatEvent, ctx: Ctx): ChatDecision | void;
}
/** Aggregated hook runner (heuristics.ts). Throwing plugins are disabled and reported via log, never propagated. */
export interface HeuristicsHost {
  onObservation(obs: Observation, ctx: Ctx): string[];
  onPlanProposed(call: ToolCall, obs: Observation, ctx: Ctx): ToolCall | { veto: string };
  onTick(snap: TickSnapshot, ctx: Ctx): ReflexIntent | undefined;
  onChat(msg: ChatEvent, ctx: Ctx): ChatDecision | undefined;
  names(): string[];
  close(): void;
}

// ---------- memory (memory.ts) ----------
export interface Place { name: string; kind: string; note: string; pos: Vec3 | null; dimension: string | null; at: number }
export interface Notes { home: Vec3 | null; zones: Zone[]; places: Place[] }
export interface NotesStore {
  get(): Readonly<Notes>;
  update(fn: (n: Notes) => void): Promise<void>; // persists atomically to paths.notesFile
}

// ---------- tools / skills (tools.ts, skills.ts) ----------
export interface ToolResult { ok: boolean; summary: string; observedDelta?: unknown }
export interface SkillEnv {
  bridge: Bridge;
  events: Events;
  config: Config;
  notes: NotesStore;
  chat: ChatPolicy;
  signal: AbortSignal; // aborted on pause / new generation / stop
  log(msg: string): void;
}
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object for the OpenAI tools array
  run(args: Record<string, unknown>, env: SkillEnv): Promise<ToolResult>;
}

// ---------- chat policy (chat-policy.ts) ----------
export type ChatRoute = { kind: "ignore" } | { kind: "model"; mustConsider: boolean } | { kind: "reply"; text: string };
export interface ChatPolicy {
  /** Classify an incoming qc.chat event (applies onChat heuristics, self-echo suppression, mentionsMe/whisper flags). */
  route(e: ChatEvent): ChatRoute;
  /** Public chat, split to ≤maxLinesPerReply lines of ≤maxLen chars, paced by minIntervalMs, through qc.chat.send. */
  say(text: string): Promise<ToolResult>;
  /** Private reply via `/msg <to> <text>` (whisper) or public addressed reply. */
  reply(to: string, text: string, privately: boolean): Promise<ToolResult>;
}

// ---------- LLM (llm.ts) ----------
export interface LlmToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export type ChatMessage =
  | { role: "system" | "user"; content: string | Array<Record<string, unknown>> }
  | { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface LlmReply { content: string | null; reasoning: string | null; toolCalls: LlmToolCall[]; usage: Record<string, unknown> }
