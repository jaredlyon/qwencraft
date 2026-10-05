import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Bridge, Config, Events, GameEvent } from './types.ts';
import { print } from './console.ts';

function gameEvent(value: unknown): GameEvent {
  if (!value || typeof value !== 'object' || !('id' in value) || !('type' in value) || !('gameTime' in value) || !('data' in value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1 || typeof value.type !== 'string' || typeof value.gameTime !== 'number') throw new Error('Invalid event envelope');
  return {id: value.id, type: value.type, gameTime: value.gameTime, data: value.data};
}

export function createEvents(b: Bridge, c: Config, signal: AbortSignal): Events {
  const subscribers = new Map<string, Set<(e: GameEvent) => void>>();
  const pending = new Map<number, GameEvent>();
  let cursor = 0, ready = false;
  function deliver(event: GameEvent) {
    for (const fn of [...(subscribers.get(event.type) ?? []), ...(subscribers.get('*') ?? [])]) {
      try { fn(event); } catch (error) { print(`Event subscriber failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    }
  }
  function flush() {
    if (!ready) return;
    while (pending.has(cursor + 1)) {
      const event = pending.get(cursor + 1)!; pending.delete(event.id); cursor = event.id; deliver(event);
    }
  }
  function lost(reason: string) {
    deliver({id: 0, type: 'controller.history_lost', gameTime: 0, data: {reason, cursor}});
  }
  let reconciliation: Promise<void> | null = null;
  function reconcile(): Promise<void> {
    if (reconciliation) return reconciliation;
    reconciliation = (async () => {
      const result = await b.rpc<{events: unknown[]; lastId: number}>('events.getRecent', {limit: 2000, sinceId: cursor}, {signal});
      if (!Array.isArray(result.events) || !Number.isSafeInteger(result.lastId) || result.lastId < 0) throw new Error('Invalid catch-up response');
      if (result.lastId < cursor) {
        lost('bridge event sequence restarted'); cursor = 0; pending.clear();
        const reset = await b.rpc<{events: unknown[]; lastId: number}>('events.getRecent', {limit: 2000, sinceId: 0}, {signal});
        result.events = reset.events; result.lastId = reset.lastId;
      }
      const recovered = result.events.map(gameEvent);
      for (const event of recovered) if (event.id > cursor) pending.set(event.id, event);
      const sorted = [...pending.keys()].filter(id => id <= result.lastId).sort((a, z) => a - z);
      const first = sorted[0];
      if (first !== undefined && first > cursor + 1) { lost('retained event history does not cover cursor'); cursor = first - 1; }
      if (first === undefined && result.lastId > cursor) { lost('event history unavailable'); cursor = result.lastId; }
      ready = true; flush();
      // An interior gap is possible when a queue dropped frames during catch-up. Reconcile again rather than skipping it.
    })().finally(() => { reconciliation = null; });
    return reconciliation;
  }
  const api: Events = {
    on(type, fn) {
      let set = subscribers.get(type); if (!set) { set = new Set(); subscribers.set(type, set); } set.add(fn);
      return () => { set.delete(fn); };
    },
    next(type, pred, timeoutMs, abort) {
      const {promise, resolve} = Promise.withResolvers<GameEvent | null>();
      let done = false;
      const finish = (event: GameEvent | null) => { if (done) return; done = true; clearTimeout(timer); off(); abort?.removeEventListener('abort', cancel); signal.removeEventListener('abort', cancel); resolve(event); };
      const off = api.on(type, event => { if (pred(event)) finish(event); });
      const timer = setTimeout(() => finish(null), timeoutMs);
      const cancel = () => finish(null);
      abort?.addEventListener('abort', cancel, {once: true}); signal.addEventListener('abort', cancel, {once: true});
      if (abort?.aborted || signal.aborted) finish(null);
      return promise;
    },
  };
  void (async () => {
    while (!signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let interval: NodeJS.Timeout | undefined;
      const connection = new AbortController();
      const combined = AbortSignal.any([signal, connection.signal]);
      try {
        const config: unknown = JSON.parse(await readFile(c.bridge.configPath, 'utf8'));
        if (!config || typeof config !== 'object' || !('token' in config) || typeof config.token !== 'string' || !config.token) throw new Error('Bridge token missing');
        const response = await fetch(`${c.bridge.url}/events`, {headers: {Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream'}, signal: combined});
        if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
        ready = false; reader = response.body.getReader();
        combined.addEventListener('abort', () => {void reader?.cancel().catch(() => {});}, {once: true});
        const consume = (async () => {
          const decoder = new TextDecoder(); let buffer = '';
          while (!combined.aborted) {
            const chunk = await reader!.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, {stream: true}).replace(/\r/g, '');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const event = gameEvent(JSON.parse(data) as unknown);
              if (event.id > cursor) pending.set(event.id, event);
              flush();
            }
            if (buffer.length > 1024 * 1024) throw new Error('SSE frame too large');
          }
        })();
        // Start reading before recovery: frames arriving during the RPC are buffered in pending.
        consume.catch(() => connection.abort());
        await reconcile();
        interval = setInterval(() => { void reconcile().catch(() => connection.abort()); }, 2000);
        await consume;
      } catch (error) {
        if (!signal.aborted) print(`Event connection lost: ${error instanceof Error ? error.message : 'unknown error'}`);
      } finally {
        clearInterval(interval); connection.abort(); await reader?.cancel().catch(() => {});
      }
      if (!signal.aborted) await delay(1000, undefined, {signal}).catch(() => {});
    }
  })();
  return api;
}
