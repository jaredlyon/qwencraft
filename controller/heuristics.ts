import { watch } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatDecision, ChatEvent, Ctx, Heuristic, HeuristicsHost, Observation, ReflexIntent, TickSnapshot, ToolCall } from "./types.ts";

interface Plugin { file: string; version: number; heuristic: Heuristic; disabled: boolean }

export async function createHeuristics(dir: string, log: (m: string) => void): Promise<HeuristicsHost> {
  await mkdir(dir, { recursive: true });
  let plugins: Plugin[] = [];
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let loading: Promise<void> = Promise.resolve();

  async function reload(): Promise<void> {
    const files = (await readdir(dir)).filter(file => file.endsWith(".ts")).sort();
    const next: Plugin[] = [];
    for (const file of files) {
      const previous = plugins.find(plugin => plugin.file === file);
      try {
        const path = join(dir, file);
        const version = (await stat(path)).mtimeMs;
        if (previous?.version === version) { next.push(previous); continue; }
        // Operator plugin filenames are selected at runtime; static imports cannot support hot reload.
        const module: unknown = await import(`${pathToFileURL(path).href}?v=${version}`);
        const value: unknown = typeof module === "object" && module !== null ? (module as Record<string, unknown>).default : undefined;
        if (typeof value !== "object" || value === null) throw new Error("default export must be a Heuristic");
        const candidate = value as Record<string, unknown>;
        if (typeof candidate.name !== "string" || !candidate.name || (candidate.priority !== undefined && (typeof candidate.priority !== "number" || !Number.isFinite(candidate.priority)))) throw new Error("invalid heuristic name/priority");
        for (const hook of ["onObservation", "onPlanProposed", "onTick", "onChat"]) {
          if (candidate[hook] !== undefined && typeof candidate[hook] !== "function") throw new Error(`${hook} must be a function`);
        }
        next.push({ file, version, heuristic: value as Heuristic, disabled: false });
      } catch (error) {
        log(`Heuristic ${file} reload failed: ${error instanceof Error ? error.message : String(error)}`);
        if (previous) next.push(previous);
      }
    }
    if (!closed) plugins = next.sort((a, b) => (b.heuristic.priority ?? 0) - (a.heuristic.priority ?? 0) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  // Hook calls are synchronous: replacing this array never changes an in-progress hook walk.
  function invoke<T>(plugin: Plugin, call: () => T): T | undefined {
    if (plugin.disabled) return undefined;
    try { return call(); }
    catch (error) {
      plugin.disabled = true;
      log(`Heuristic ${plugin.file} disabled until file changes: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  await reload();
  const watcher = watch(dir, (_event, file) => {
    if (closed || (file !== null && !String(file).endsWith(".ts"))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      loading = loading.then(reload).catch(error => log(`Heuristic reload failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 200);
  });
  watcher.on("error", error => log(`Heuristic watcher failed: ${error.message}`));

  return {
    onObservation(obs: Observation, ctx: Ctx): string[] {
      const hints: string[] = [];
      for (const plugin of plugins) {
        const result = invoke(plugin, () => {
          const value = plugin.heuristic.onObservation?.(obs, ctx);
          if (value !== undefined && (!Array.isArray(value) || !value.every(hint => typeof hint === "string"))) throw new Error("onObservation must return string[] or undefined");
          return value;
        });
        if (result) hints.push(...result);
      }
      return hints;
    },
    onPlanProposed(call: ToolCall, obs: Observation, ctx: Ctx): ToolCall | { veto: string } {
      let current = call;
      for (const plugin of plugins) {
        const result = invoke(plugin, () => {
          const value = plugin.heuristic.onPlanProposed?.(current, obs, ctx);
          if (value !== undefined && (!("veto" in value) ? typeof value.name !== "string" || typeof value.args !== "object" || value.args === null || Array.isArray(value.args) : typeof value.veto !== "string")) throw new Error("invalid onPlanProposed result");
          return value;
        });
        if (result && "veto" in result) return result;
        if (result) current = result;
      }
      return current;
    },
    onTick(snap: TickSnapshot, ctx: Ctx): ReflexIntent | undefined {
      if (snap.paused) return undefined;
      for (const plugin of plugins) {
        const result = invoke(plugin, () => {
          const value = plugin.heuristic.onTick?.(snap, ctx);
          if (value !== undefined && (typeof value.reason !== "string" || typeof value.call?.name !== "string" || typeof value.call.args !== "object" || value.call.args === null || Array.isArray(value.call.args))) throw new Error("invalid onTick result");
          return value;
        });
        if (result) return result;
      }
      return undefined;
    },
    onChat(msg: ChatEvent, ctx: Ctx): ChatDecision | undefined {
      for (const plugin of plugins) {
        const result = invoke(plugin, () => {
          const value = plugin.heuristic.onChat?.(msg, ctx);
          if (value !== undefined && (!("reply" in value && typeof value.reply === "string") && !("ignore" in value && value.ignore === true) && !("toModel" in value && value.toModel === true))) throw new Error("invalid onChat result");
          return value;
        });
        if (result) return result;
      }
      return undefined;
    },
    names() { return plugins.filter(plugin => !plugin.disabled).map(plugin => plugin.heuristic.name); },
    close() { closed = true; clearTimeout(timer); watcher.close(); },
  };
}
