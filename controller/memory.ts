import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage, Config, Notes, NotesStore } from "./types.ts";

function validateNotes(value: unknown): asserts value is Notes {
  if (typeof value !== "object" || value === null) throw new Error("notes must be an object");
  const notes = value as Record<string, unknown>;
  const vec = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
  if (notes.home !== null && !vec(notes.home)) throw new Error("invalid notes.home");
  if (!Array.isArray(notes.zones) || !Array.isArray(notes.places)) throw new Error("invalid notes.zones/places");
  for (const zone of notes.zones) {
    if (typeof zone !== "object" || zone === null) throw new Error("invalid notes zone");
    const z = zone as Record<string, unknown>;
    if (typeof z.name !== "string" || !z.name || !vec(z.min) || !vec(z.max) || !(z.min as number[]).every((n, i) => n <= (z.max as number[])[i]!)) throw new Error("invalid notes zone");
  }
  for (const place of notes.places) {
    if (typeof place !== "object" || place === null) throw new Error("invalid notes place");
    const p = place as Record<string, unknown>;
    if (typeof p.name !== "string" || typeof p.kind !== "string" || typeof p.note !== "string" || (p.pos !== null && !vec(p.pos)) || (p.dimension !== null && typeof p.dimension !== "string") || typeof p.at !== "number" || !Number.isFinite(p.at)) throw new Error("invalid notes place");
  }
}

export async function createNotesStore(path: string, c: Config): Promise<NotesStore> {
  let notes: Notes = { home: null, zones: [], places: [] };
  let contents: string | undefined;
  try { contents = await readFile(path, "utf8"); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw new Error(`memory read failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (contents !== undefined) {
    try {
      const value: unknown = JSON.parse(contents);
      if (typeof value !== "object" || value === null) throw new Error("invalid notes envelope");
      const envelope = value as Record<string, unknown>;
      const server = envelope.server;
      if (typeof server !== "object" || server === null || !("host" in server) || !("port" in server) || typeof server.host !== "string" || typeof server.port !== "number") throw new Error("missing notes server scope");
      validateNotes(envelope.notes);
      if (server.host.toLowerCase() !== c.server.host.toLowerCase() || server.port !== c.server.port) {
        await rename(path, `${path}.${Date.now()}.${randomUUID()}.bak`);
      } else notes = structuredClone(envelope.notes);
    } catch (error) {
      throw new Error(`memory read failed (${path}); prior data preserved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let queue: Promise<void> = Promise.resolve();
  return {
    get() { return structuredClone(notes); },
    update(fn) {
      const update = queue.then(async () => {
        const next = structuredClone(notes);
        fn(next);
        validateNotes(next);
        const persisted = structuredClone(next);
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ server: { host: c.server.host, port: c.server.port }, observedAt: Date.now(), notes: persisted }, null, 2), { encoding: "utf8", flag: "wx" });
          await rename(temp, path);
          notes = persisted;
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`memory write failed; prior data preserved: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      queue = update.catch(() => undefined);
      return update;
    },
  };
}

interface History {
  add(m: ChatMessage): void;
  messages(): ChatMessage[];
  summary: string;
  compactable(): ChatMessage[];
  replaceOldest(n: number, summary: string): void;
}

export function createHistory(maxMessages: number): History {
  if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error("maxMessages must be positive");
  let entries: ChatMessage[] = [];
  let summary = "";

  function groupEnds(): number[] {
    const ends: number[] = [];
    for (let i = 0; i < entries.length;) {
      const message = entries[i]!;
      if (message.role === "tool") throw new Error("orphan tool message in history");
      if (message.role === "assistant" && message.tool_calls?.length) {
        const ids = new Set(message.tool_calls.map(call => call.id));
        let end = i + 1;
        while (end < entries.length && entries[end]!.role === "tool") {
          const result = entries[end]!;
          if (result.role === "tool") ids.delete(result.tool_call_id);
          end++;
        }
        if (ids.size > 0) break;
        i = end;
      } else i++;
      ends.push(i);
    }
    return ends;
  }

  return {
    add(message) {
      if (message.role === "tool") {
        let i = entries.length - 1;
        const completed = new Set<string>();
        while (i >= 0 && entries[i]!.role === "tool") {
          const previous = entries[i]!;
          if (previous.role === "tool") completed.add(previous.tool_call_id);
          i--;
        }
        const assistant = entries[i];
        if (assistant?.role !== "assistant" || !assistant.tool_calls?.some(call => call.id === message.tool_call_id) || completed.has(message.tool_call_id)) throw new Error("orphan or duplicate tool result");
      } else {
        const lastAssistant = entries.findLast(m => m.role === "assistant" && Boolean(m.tool_calls?.length));
        if (lastAssistant?.role === "assistant" && lastAssistant.tool_calls?.some(call => !entries.some(m => m.role === "tool" && m.tool_call_id === call.id))) throw new Error("previous tool-call group incomplete");
      }
      const copy = structuredClone(message);
      if (copy.role === "assistant") {
        copy.content = copy.content?.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim() ?? null;
        if (copy.tool_calls) {
          const ids = new Set(copy.tool_calls.map(call => call.id));
          if (ids.size !== copy.tool_calls.length || copy.tool_calls.some(call => !call.id || entries.some(m => m.role === "assistant" && m.tool_calls?.some(previous => previous.id === call.id)))) throw new Error("ambiguous tool-call IDs");
        }
        // Copy only the binding message fields, even if runtime data included hidden reasoning.
        entries.push({ role: "assistant", content: copy.content, ...(copy.tool_calls ? { tool_calls: copy.tool_calls } : {}) });
      } else entries.push(copy);
    },
    messages() { return structuredClone(entries); },
    get summary() { return summary; },
    set summary(value: string) { summary = value.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim(); },
    compactable() {
      const excess = entries.length - maxMessages;
      if (excess <= 0) return [];
      const ends = groupEnds().filter(end => end < entries.length);
      const cutoff = ends.find(end => end >= excess) ?? ends.at(-1) ?? 0;
      return structuredClone(entries.slice(0, cutoff));
    },
    replaceOldest(n, newSummary) {
      if (!Number.isInteger(n) || n <= 0 || n >= entries.length || !groupEnds().includes(n)) throw new Error("history compaction must replace complete older groups");
      summary = newSummary.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
      entries = entries.slice(n);
    },
  };
}
