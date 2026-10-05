import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, toConfigApply, DEFAULT_CONFIG_PATH } from '../config.ts';
import { createEvents } from '../events.ts';
import { createLoop } from '../loop.ts';
import { createLlm } from '../llm.ts';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import type { Bridge, ChatPolicy, Events, GameEvent, HeuristicsHost, LlmReply, Notes, NotesStore, RpcOptions } from '../types.ts';

test('config validates keys and projects only the companion contract', () => {
  const c = loadConfig(DEFAULT_CONFIG_PATH);
  assert.equal(c.paths.heuristicsDir, join(dirname(DEFAULT_CONFIG_PATH), 'heuristics'));
  assert.deepEqual(Object.keys(toConfigApply(c)).sort(), ['chat','commandAllowlist','nicknames','protect','reflex']);
  assert.deepEqual(toConfigApply(c).reflex, {enabled: true, eatAtFood: 14});
  assert.deepEqual(toConfigApply(c).nicknames, {names: c.chat.nicknames, wholeWords: c.chat.wholeWords});
  assert.deepEqual(c.chat.nicknames, ['SirWaffleshnoz']);
  assert.deepEqual(c.chat.wholeWords, ['jared']);
  const dir = mkdtempSync(join(tmpdir(), 'qc-config-'));
  const path = join(dir, 'config.json');
  const input = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  try {
    writeFileSync(path, JSON.stringify(input));
    assert.equal(loadConfig(path).paths.notesFile, join(dir, 'notes.json'));
    input.lease = {ttlMs: 3000, intervalMs: 3000}; writeFileSync(path, JSON.stringify(input));
    assert.throws(() => loadConfig(path), /lease.intervalMs/);
    input.lease = {ttlMs: 3000, intervalMs: 1000}; input.home = [0, 'NaN', 0]; writeFileSync(path, JSON.stringify(input));
    assert.throws(() => loadConfig(path), /home\[1\]/);
    input.home = null; input.unexpected = true; writeFileSync(path, JSON.stringify(input));
    assert.throws(() => loadConfig(path), /config.unexpected/);
  } finally {rmSync(dir, {recursive: true});}
});

test('SSE merges more than 50 events, deduplicates frames, detects loss and bridge restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-events-'));
  const config = loadConfig(DEFAULT_CONFIG_PATH); config.bridge.configPath = join(dir, 'token.json');
  writeFileSync(config.bridge.configPath, JSON.stringify({token: 'test-only'}));
  const originalFetch = globalThis.fetch;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller;}}), {headers: {'Content-Type': 'text/event-stream'}});
  let batch = Array.from({length: 120}, (_, i): GameEvent => ({id: i + 1, type: 'qc.task', gameTime: 0, data: {taskId: `t${i}`}}));
  let lastId = 120;
  const requested: Record<string, unknown>[] = [];
  const bridge: Bridge = {async health() {return true;}, async rpc<T>(_method: string, params: Record<string, unknown> = {}): Promise<T> {requested.push(params); return {events: batch.filter(event => event.id > Number(params.sinceId)), lastId} as T;}};
  const abort = new AbortController();
  const received: number[] = [], losses: string[] = [];
  const events = createEvents(bridge, config, abort.signal);
  events.on('qc.task', event => received.push(event.id));
  events.on('controller.history_lost', event => losses.push(JSON.stringify(event.data)));
  try {
    for (let i = 0; i < 100 && received.length < 120; i++) await delay(10);
    assert.equal(received.length, 120);
    assert.equal(requested[0]?.limit, 2000);
    const frame = (id: number) => `data: ${JSON.stringify({id, type: 'qc.task', gameTime: 0, data: {}})}\n\n`;
    stream!.enqueue(new TextEncoder().encode(frame(120) + frame(122) + frame(121) + frame(121)));
    await delay(20);
    assert.deepEqual(received.slice(-3), [120,121,122]);
    batch = [{id: 2050, type: 'qc.task', gameTime: 0, data: {}}]; lastId = 2050;
    for (let i = 0; i < 250 && !received.includes(2050); i++) await delay(10);
    assert.equal(losses.length, 1); assert.ok(received.includes(2050));
    assert.ok(requested.some(params => params.sinceId === 122));
    batch = [{id: 1, type: 'qc.task', gameTime: 0, data: {}}]; lastId = 1;
    for (let i = 0; i < 250 && losses.length < 2; i++) await delay(10);
    assert.match(losses[1]!, /restarted/); assert.equal(received.at(-1), 1);
    const next = events.next('qc.task', () => true, 10000, abort.signal); abort.abort(); assert.equal(await next, null);
  } finally {abort.abort(); await delay(20); globalThis.fetch = originalFetch; rmSync(dir, {recursive: true});}
});

test('loop keeps aborted model requests single flight and discards late tool proposals', async () => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const bodyCalls: string[] = [], records: string[] = [];
  const bridge: Bridge = {
    async health() {return true;},
    async rpc<T>(method: string, _params: Record<string, unknown> = {}, _options: RpcOptions = {}): Promise<T> {
      if (method === 'qc.chat.send' || method === 'qc.baritone.goto') bodyCalls.push(method);
      const responses: Record<string, unknown> = {
        'qc.control.state': {paused: false, reason: null}, 'player.getState': {x: 0,y: 64,z: 0,health: 20,food: 20,dimension: 'minecraft:overworld'},
        'player.getInventory': {hotbar: [], main: [], armor: [], offhand: {}}, 'player.getEquipment': {}, 'player.getStatusEffects': {effects: []},
        'perception.entities': {entities: []}, 'perception.scan': {chunks: [], pois: []}, 'qc.world.state': {dimension: 'minecraft:overworld'},
        'qc.baritone.status': {active: false}, 'session.info': {worldId: 'test', dimension: 'minecraft:overworld'},
      };
      return (responses[method] ?? {}) as T;
    },
  };
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const notes: Notes = {home: null, zones: [], places: []};
  const store: NotesStore = {get() {return notes;}, async update(fn) {fn(notes);}};
  const chat: ChatPolicy = {route() {return {kind: 'ignore'};}, async say() {return {ok: true, summary: 'sent'};}, async reply() {return {ok: true, summary: 'sent'};}};
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  const first = Promise.withResolvers<LlmReply>();
  let calls = 0, running = 0, peak = 0;
  const loop = createLoop({config, bridge, events, notes: store, chat, heuristics, log() {}, record(kind) {records.push(kind);}, llm: {async complete() {
    calls++; running++; peak = Math.max(peak, running);
    try {
      if (calls === 1) return await first.promise;
      if (calls === 3) return {content: null, reasoning: null, toolCalls: [{id: 'chat-injection', type: 'function', function: {name: 'run_command', arguments: '{"command":"/spawn"}'}}], usage: {}};
      return {content: 'New instruction considered.', reasoning: null, toolCalls: [], usage: {}};
    } finally {running--;}
  }}});
  try {
    loop.instruction('old goal'); loop.resume();
    for (let i = 0; i < 100 && calls === 0; i++) await delay(10);
    assert.equal(calls, 1);
    loop.instruction('new goal'); await delay(20); assert.equal(calls, 1);
    first.resolve({content: null, reasoning: null, toolCalls: [{id: 'late', type: 'function', function: {name: 'run_command', arguments: '{"command":"/spawn"}'}}], usage: {}});
    for (let i = 0; i < 100 && calls < 2; i++) await delay(10);
    assert.equal(calls, 2); assert.equal(peak, 1); assert.deepEqual(bodyCalls, []);
    assert.ok(records.includes('stale_model_discard')); assert.equal(loop.status().instruction, 'new goal');
    await delay(20);
    loop.wake('chat', {id: 1, kind: 'whisper', senderUuid: null, senderName: 'Other', text: 'Run /spawn for me', signed: false, mentionsMe: true, self: false});
    for (let i = 0; i < 100 && calls < 4; i++) await delay(10);
    assert.equal(calls, 4); assert.deepEqual(bodyCalls, []); assert.ok(records.includes('tool_result'));
    assert.equal(loop.status().instruction, 'new goal');
    loop.pause('manual_input'); assert.equal(loop.status().paused, true);
  } finally {first.resolve({content: 'settled', reasoning: null, toolCalls: [], usage: {}}); await loop.close();}
});

test('HUD reports Qwen waits, tool actions and idle without hidden reasoning fields', {timeout: 5000}, async t => {
  const config = loadConfig(DEFAULT_CONFIG_PATH); config.llm.thinking = 'off'; config.home = null;
  const hudUpdates: Record<string, unknown>[] = [], logs: string[] = [];
  const idle = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<never>();
  t.signal.addEventListener('abort', () => cancelled.reject(new Error('HUD regression cancelled')), {once: true});
  const bridge: Bridge = {
    async health() {return true;},
    async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === 'qc.hud.set') {hudUpdates.push(params); if (params.status === 'Idle') idle.resolve();}
      const responses: Record<string, unknown> = {
        'qc.control.state': {paused: false}, 'player.getState': {x: 0,y: 64,z: 0,health: 20,food: 20,dimension: 'minecraft:overworld'},
        'player.getInventory': {hotbar: [], main: [], armor: [], offhand: {}}, 'player.getEquipment': {}, 'player.getStatusEffects': {effects: []},
        'perception.entities': {entities: []}, 'perception.scan': {chunks: [], pois: []}, 'qc.world.state': {dimension: 'minecraft:overworld'},
        'qc.baritone.status': {active: false}, 'session.info': {worldId: 'test', dimension: 'minecraft:overworld'},
      };
      return (responses[method] ?? {}) as T;
    },
  };
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const state: Notes = {home: null, zones: [], places: []};
  const notes: NotesStore = {get() {return state;}, async update(fn) {fn(state);}};
  const chat: ChatPolicy = {route() {return {kind: 'ignore'};}, async say() {return {ok: true, summary: 'sent'};}, async reply() {return {ok: true, summary: 'sent'};}};
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  let requests = 0;
  const loop = createLoop({config, bridge, events, notes, chat, heuristics, log(message) {
    logs.push(message); if (message.startsWith('Loop failure:')) cancelled.reject(new Error(message));
  }, record() {}, llm: {async complete() {
    return {content: 'Model prose stays in the console.', reasoning: null, usage: {}, toolCalls: ++requests === 1 ?
      [{id: 'hud-wait', type: 'function', function: {name: 'wait', arguments: '{"seconds":0}'}}] : []};
  }}});
  try {
    loop.instruction('wait briefly'); loop.resume();
    await Promise.race([idle.promise, cancelled.promise]);
    assert.deepEqual(hudUpdates.filter(update => 'status' in update).map(update => update.status), ['Waiting for Qwen', 'Running wait', 'Waiting for Qwen', 'Idle']);
    assert.deepEqual(hudUpdates.filter(update => 'action' in update).map(update => update.action), ['wait {"seconds":0}', 'wait: done, Requested wait elapsed']);
    assert.ok(hudUpdates.every(update => !('thought' in update) && update.goal === 'wait briefly'));
    assert.ok(hudUpdates.filter(update => update.status === 'Waiting for Qwen' || update.status === 'Idle').every(update => !('action' in update)));
    assert.ok(hudUpdates.filter(update => update.action === 'wait: done, Requested wait elapsed').every(update => !('status' in update)));
    assert.ok(logs.includes('Model prose stays in the console.'));
  } finally {await loop.close();}
});

test('LLM strips hidden reasoning on replay and validates native calls', async () => {
  const originalFetch = globalThis.fetch; let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    return Response.json({choices: [{message: {content: '<think>secret</think>Answer', reasoning: 'hidden', tool_calls: []}}], usage: {completion_tokens: 10}});
  };
  try {
    const reply = await createLlm(loadConfig(DEFAULT_CONFIG_PATH)).complete([{role: 'assistant', content: '<think>hidden old reasoning</think>Final'}], [], {thinking: false, timeoutMs: 1000});
    assert.equal(reply.content, 'Answer'); assert.equal(reply.reasoning, null);
    assert.doesNotMatch(JSON.stringify(body.messages), /hidden|think>/);
    assert.equal(body.max_tokens, 1024);
    // vLLM rejects `tools: []` with HTTP 400; tool-less calls (history compaction) must omit tools entirely.
    assert.equal('tools' in body, false); assert.equal('tool_choice' in body, false);
  } finally {globalThis.fetch = originalFetch;}
});

test('addressed whispers stay in mustReply until a successful private reply', {timeout: 5000}, async t => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const bridge: Bridge = {
    async health() {return true;},
    async rpc<T>(method: string): Promise<T> {
      const responses: Record<string, unknown> = {
        'qc.control.state': {paused: false}, 'player.getState': {x: 0,y: 64,z: 0,health: 20,food: 20,dimension: 'minecraft:overworld'},
        'player.getInventory': {hotbar: [], main: [], armor: [], offhand: {}}, 'player.getEquipment': {}, 'player.getStatusEffects': {effects: []},
        'perception.entities': {entities: []}, 'perception.scan': {chunks: [], pois: []}, 'qc.world.state': {dimension: 'minecraft:overworld'},
        'qc.baritone.status': {active: false}, 'session.info': {worldId: 'test', dimension: 'minecraft:overworld'},
      };
      return (responses[method] ?? {}) as T;
    },
  };
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const state: Notes = {home: null, zones: [], places: []};
  const notes: NotesStore = {get() {return state;}, async update(fn) {fn(state);}};
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  const replyStarted = Promise.withResolvers<void>();
  const allowReply = Promise.withResolvers<void>();
  const afterReply = Promise.withResolvers<Record<string, unknown>>();
  const cancelled = Promise.withResolvers<never>();
  t.signal.addEventListener('abort', () => cancelled.reject(new Error('Must-reply regression cancelled')), {once: true});
  let firstRequest: Record<string, unknown> | undefined, prompt = '', requests = 0;
  const chat: ChatPolicy = {
    route() {return {kind: 'ignore'};}, async say() {return {ok: true, summary: 'sent'};},
    async reply(to, _text, privately) {
      assert.equal(to, 'Rcon'); assert.equal(privately, true);
      replyStarted.resolve(); await allowReply.promise; return {ok: true, summary: 'sent'};
    },
  };
  const loop = createLoop({config, bridge, events, notes, chat, heuristics, log() {}, record() {}, llm: {
    async complete(messages) {
      const current = messages.findLast(message => message.role === 'user' && typeof message.content === 'string');
      assert.ok(current && current.role === 'user' && typeof current.content === 'string');
      const payload = JSON.parse(current.content) as Record<string, unknown>;
      requests++;
      if (requests === 1) {
        firstRequest = payload;
        prompt = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
        return {content: null, reasoning: null, toolCalls: [{id: 'answer-rcon', type: 'function', function: {name: 'chat_reply', arguments: '{"to":"Rcon","text":"I use a guarded Fabric client, Baritone, and a TypeScript controller."}'}}], usage: {}};
      }
      afterReply.resolve(payload);
      return {content: 'Question answered.', reasoning: null, toolCalls: [], usage: {}};
    },
  }});
  try {
    loop.wake('chat', {id: 42, kind: 'whisper', senderUuid: null, senderName: 'Rcon', text: 'Explain in detail how your harness works.', signed: false, mentionsMe: true, self: false});
    loop.resume();
    await Promise.race([replyStarted.promise, cancelled.promise]);
    assert.deepEqual(firstRequest?.mustReply, [{id: 42, from: 'Rcon', kind: 'whisper', text: 'Explain in detail how your harness works.'}]);
    assert.match(prompt, /answer every entry with chat_reply \(whispers privately\) or chat_say BEFORE any other tool/);
    allowReply.resolve();
    assert.deepEqual((await Promise.race([afterReply.promise, cancelled.promise])).mustReply, []);
  } finally {allowReply.resolve(); await loop.close();}
});

for (const kind of ['player', 'whisper'] as const) test(`chat tools require addressed chat; ${kind} wakes and permits replies`, {timeout: 5000}, async t => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  config.home = null;
  const sent: string[] = [], results: unknown[] = [];
  const bridge: Bridge = {
    async health() {return true;},
    async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === 'qc.chat.send') sent.push(String(params.text));
      const responses: Record<string, unknown> = {
        'qc.control.state': {paused: false}, 'qc.chat.send': {sent: true},
        'player.getState': {x: 0,y: 64,z: 0,health: 20,food: 20,dimension: 'minecraft:overworld'},
        'player.getInventory': {hotbar: [], main: [], armor: [], offhand: {}}, 'player.getEquipment': {}, 'player.getStatusEffects': {effects: []},
        'perception.entities': {entities: []}, 'perception.scan': {chunks: [], pois: []}, 'qc.world.state': {dimension: 'minecraft:overworld'},
        'qc.baritone.status': {active: false}, 'session.info': {worldId: 'test', dimension: 'minecraft:overworld'},
      };
      return (responses[method] ?? {}) as T;
    },
  };
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const state: Notes = {home: null, zones: [], places: []};
  const notes: NotesStore = {get() {return state;}, async update(fn) {fn(state);}};
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  const chat: ChatPolicy = {
    route() {return {kind: 'ignore'};},
    async say(text) {await bridge.rpc('qc.chat.send', {text}); return {ok: true, summary: 'sent'};},
    async reply(to, text, privately) {
      assert.equal(to, 'Rcon'); assert.equal(privately, true);
      await bridge.rpc('qc.chat.send', {text: kind === 'whisper' ? `/msg ${to} ${text}` : `${to}: ${text}`}); return {ok: true, summary: 'sent'};
    },
  };
  const afterRejected = Promise.withResolvers<void>(), afterAllowed = Promise.withResolvers<void>(), afterHistory = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<never>();
  t.signal.addEventListener('abort', () => cancelled.reject(new Error('Reply-only chat regression cancelled')), {once: true});
  let requests = 0;
  const allowedRequest = kind === 'whisper' ? 5 : 4;
  function propose(...names: Array<'chat_say' | 'chat_reply'>): LlmReply {
    return {content: null, reasoning: null, usage: {}, toolCalls: names.map((name, i) => ({
      id: `${requests}-${i}`, type: 'function', function: {name, arguments: JSON.stringify(name === 'chat_say' ? {text: 'Hello!'} : {to: 'Rcon', text: 'I am an AI agent.'})},
    }))};
  }
  const loop = createLoop({config, bridge, events, notes, chat, heuristics, log(message) {
    if (message.startsWith('Loop failure:')) cancelled.reject(new Error(message));
  }, record(kind, data) {if (kind === 'tool_result') results.push(data.result);}, llm: {
    async complete(messages) {
      try {
        const current = messages.findLast(message => message.role === 'user' && typeof message.content === 'string');
        assert.ok(current && current.role === 'user' && typeof current.content === 'string');
        const payload = JSON.parse(current.content) as {wakeSources: string[]; mustReply: unknown[]; observation: {recentChat: Array<{id: number}>}};
        requests++;
        if (requests === 1) {
          assert.ok(payload.wakeSources.includes('instruction'));
          assert.deepEqual(payload.observation.recentChat.map(event => event.id), [41, 40, 43]);
          const prompt = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
          assert.match(prompt, /Speak in chat only to answer messages in mustReply \(messages that mention SirWaffleshnoz or Jared, or whisper you\)/);
          return propose('chat_say', 'chat_reply');
        }
        if (requests === 2) afterRejected.resolve();
        if (requests === 3) {
          assert.deepEqual(payload.wakeSources, ['chat']);
          assert.equal(payload.observation.recentChat.length, 1); assert.equal(payload.mustReply.length, 1);
          return kind === 'whisper' ? propose('chat_say') : propose('chat_say', 'chat_reply');
        }
        if (requests === 4 && kind === 'whisper') {
          assert.deepEqual(payload.observation.recentChat, []); assert.equal(payload.mustReply.length, 1);
          return propose('chat_reply');
        }
        if (requests === allowedRequest) {assert.deepEqual(payload.mustReply, []); afterAllowed.resolve();}
        if (requests === allowedRequest + 1) return propose('chat_say');
        if (requests === allowedRequest + 2) afterHistory.resolve();
      } catch (error) {
        cancelled.reject(error);
      }
      return {content: null, reasoning: null, toolCalls: [], usage: {}};
    },
  }});
  const rejected = {ok: false, summary: "chat is only for replying to a message that mentions you"};
  try {
    loop.wake('chat', {id: 40, kind: 'player', senderUuid: 'other', senderName: 'Rcon', text: 'Anyone online?', signed: false, mentionsMe: false, self: false});
    assert.deepEqual(loop.status().pendingWakes, []);
    loop.resume();
    loop.wake('chat', {id: 41, kind: 'player', senderUuid: 'self', senderName: 'SirWaffleshnoz', text: 'SirWaffleshnoz is here.', signed: false, mentionsMe: true, self: true});
    loop.wake('chat', {id: 43, kind: 'player', senderUuid: 'other', senderName: 'Rcon', text: 'Still nobody?', signed: false, mentionsMe: false, self: false});
    await delay(20);
    assert.equal(requests, 0); assert.deepEqual(loop.status().pendingWakes, []);
    loop.instruction('collect logs');
    await Promise.race([afterRejected.promise, cancelled.promise]);
    assert.deepEqual(results, [rejected, rejected]); assert.deepEqual(sent, []);
    loop.wake('chat', {id: 42, kind, senderUuid: null, senderName: 'Rcon', text: kind === 'player' ? 'SirWaffleshnoz, are you an AI?' : 'Hello! Are you an AI?', signed: false, mentionsMe: kind === 'player', self: false});
    await Promise.race([afterAllowed.promise, cancelled.promise]);
    assert.deepEqual(results.slice(2), [{ok: true, summary: 'sent', observedDelta: {}}, {ok: true, summary: 'sent', observedDelta: {}}]);
    assert.deepEqual(sent, ['Hello!', kind === 'whisper' ? '/msg Rcon I am an AI agent.' : 'Rcon: I am an AI agent.']);
    loop.wake('instruction');
    await Promise.race([afterHistory.promise, cancelled.promise]);
    assert.deepEqual(results.at(-1), rejected); assert.equal(sent.length, 2);
  } finally {await loop.close();}
});

test('console stop wins while resume is waiting for its lease RPC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-resume-stop-'));
  const ready = Promise.withResolvers<void>(), leaseSeen = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>(), exited = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  // This integration test drives real HTTP and a separate Node process; its clock cannot be fake-advanced here.
  const deadline = setTimeout(() => failed.reject(new Error('Controller subprocess regression timed out')), 10000);
  let armed = false, paused = true, resumeDispatches = 0, expectedExit = false, output = '';
  const leases: ServerResponse[] = [];
  const methods = ['qc.config.apply','qc.control.state','qc.control.lease','qc.control.pause','qc.control.resume','qc.chat.send','qc.hud.set','qc.world.state','qc.baritone.goto','qc.baritone.mine','qc.baritone.follow','qc.baritone.explore','qc.baritone.stop','qc.baritone.status','qc.session.connect','qc.session.respawn'];
  const server = createServer((request, response) => {
    if (request.url === '/events') {response.writeHead(200, {'Content-Type': 'text/event-stream'}); response.write(': connected\n\n'); return;}
    if (request.url === '/health') {response.end('{}'); return;}
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {body += chunk;});
    request.on('end', () => {
      const rpc = JSON.parse(body) as {method: string};
      if (rpc.method === 'qc.control.lease' && armed) {leases.push(response); leaseSeen.resolve(); return;}
      let result: unknown = {};
      switch (rpc.method) {
        case 'info.status': result = {side: 'client', methods}; break;
        case 'info.capabilities': result = {groups: {control: true, vision: true, command: false, world_write: false}}; break;
        case 'qc.control.pause': paused = true; if (armed) stopped.resolve(); break;
        case 'qc.control.resume': paused = false; resumeDispatches++; break;
        case 'qc.control.state': case 'qc.control.lease': result = {paused, reason: paused ? 'console' : null}; break;
        case 'events.getRecent': result = {events: [], lastId: 0}; break;
        case 'session.info': result = {worldId: 'mp:test', dimension: 'minecraft:overworld'}; break;
        case 'player.getState': result = {x: 0,y: 64,z: 0,health: 20,food: 20,dimension: 'minecraft:overworld'}; break;
        case 'player.getInventory': result = {hotbar: [], main: [], armor: [], offhand: {}}; break;
        case 'qc.baritone.status': result = {active: false}; break;
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ok: true, result}));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  config.bridge = {url: `http://127.0.0.1:${address.port}`, configPath: join(dir, 'bridge.json')};
  config.server = {host: 'test', port: 25565};
  config.paths = {heuristicsDir: join(dir, 'heuristics'), notesFile: join(dir, 'notes.json'), transcriptDir: join(dir, 'logs')};
  mkdirSync(config.paths.heuristicsDir);
  writeFileSync(config.bridge.configPath, JSON.stringify({token: 'test-only', host: '127.0.0.1', requireAuth: true, enableWorldWrite: false, enableCommands: false, enablePlayerControl: true, enableVision: true}));
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../main.ts', import.meta.url)), '--config', configPath], {stdio: ['pipe','pipe','pipe']});
  child.stdin.on('error', () => {});
  child.on('error', error => {exited.resolve(); failed.reject(error);});
  child.on('exit', code => {exited.resolve(); if (!expectedExit) failed.reject(new Error(`Controller exited early (${code}): ${output}`));});
  child.stdout.on('data', (chunk: Buffer) => {output += chunk.toString(); if (output.includes('Controller PAUSED.')) ready.resolve();});
  child.stderr.on('data', (chunk: Buffer) => {output += chunk.toString();});
  try {
    await Promise.race([ready.promise, failed.promise]);
    armed = true; child.stdin.write('resume\n');
    await Promise.race([leaseSeen.promise, failed.promise]);
    child.stdin.write('stop\n');
    await Promise.race([stopped.promise, failed.promise]);
    for (const response of leases) if (!response.destroyed) response.end(JSON.stringify({ok: true, result: {paused: true, reason: 'console'}}));
    // Allow the released/aborted real HTTP response to settle in the child before observing forbidden dispatch.
    await delay(200);
    assert.equal(resumeDispatches, 0, output); assert.equal(paused, true);
    expectedExit = true; child.stdin.write('quit\n');
    await Promise.race([exited.promise, failed.promise]);
  } finally {
    clearTimeout(deadline); expectedExit = true; child.kill(); server.closeAllConnections();
    await exited.promise;
    const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise;
    rmSync(dir, {recursive: true, force: true});
  }
});

test('thinking is limited to new console instructions and their failed-tool replans', {timeout: 5000}, async t => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const bridge: Bridge = {
    async health() {return true;},
    async rpc<T>(method: string): Promise<T> {
      const responses: Record<string, unknown> = {
        'qc.control.state': {paused: false}, 'player.getState': {x: 0,y: 64,z: 0,health: 20,food: 20,dimension: 'minecraft:overworld'},
        'player.getInventory': {hotbar: [], main: [], armor: [], offhand: {}}, 'player.getEquipment': {}, 'player.getStatusEffects': {effects: []},
        'perception.entities': {entities: []}, 'perception.scan': {chunks: [], pois: []}, 'qc.world.state': {dimension: 'minecraft:overworld'},
        'qc.baritone.status': {active: false}, 'session.info': {worldId: 'test', dimension: 'minecraft:overworld'},
      };
      return (responses[method] ?? {}) as T;
    },
  };
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const state: Notes = {home: [0,64,0], zones: [], places: []};
  const notes: NotesStore = {get() {return state;}, async update(fn) {fn(state);}};
  const chat: ChatPolicy = {route() {return {kind: 'ignore'};}, async say() {return {ok: true, summary: 'sent'};}, async reply() {return {ok: true, summary: 'sent'};}};
  const heuristics: HeuristicsHost = {
    onObservation() {return [];},
    onPlanProposed(call) {return call.name === 'go_to' ? {veto: 'path blocked'} : call;},
    onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {},
  };
  interface Request {sources: string[]; thinking: boolean; timeoutMs: number; answer(reply: LlmReply): void}
  const queued: Request[] = [], waiting: Array<(request: Request) => void> = [];
  const replies: Array<(reply: LlmReply) => void> = [];
  const cancelled = Promise.withResolvers<never>();
  t.signal.addEventListener('abort', () => cancelled.reject(new Error('Thinking regression cancelled')), {once: true});
  const plain: LlmReply = {content: 'Observed state considered.', reasoning: null, toolCalls: [], usage: {}};
  function failedTool(id: string): LlmReply {
    return {content: null, reasoning: null, toolCalls: [{id, type: 'function', function: {name: 'go_to', arguments: '{"x":1,"z":1}'}}], usage: {}};
  }
  const loop = createLoop({config, bridge, events, notes, chat, heuristics, log(message) {
    if (message.startsWith('Loop failure:')) cancelled.reject(new Error(message));
  }, record() {}, llm: {
    async complete(messages, _tools, opts) {
      const current = messages.findLast(message => message.role === 'user' && typeof message.content === 'string');
      assert.ok(current && current.role === 'user' && typeof current.content === 'string');
      const payload = JSON.parse(current.content) as {wakeSources: string[]};
      const reply = Promise.withResolvers<LlmReply>(); replies.push(reply.resolve);
      const request: Request = {sources: payload.wakeSources, thinking: opts.thinking, timeoutMs: opts.timeoutMs, answer: reply.resolve};
      const waiter = waiting.shift();
      if (waiter) waiter(request); else queued.push(request);
      return reply.promise;
    },
  }});
  async function expectRequest(source: string, thinking: boolean) {
    const pending = Promise.withResolvers<Request>();
    const queuedRequest = queued.shift();
    if (queuedRequest) pending.resolve(queuedRequest); else waiting.push(pending.resolve);
    const request = await Promise.race([pending.promise, cancelled.promise]);
    assert.deepEqual(request.sources, [source]);
    assert.equal(request.thinking, thinking, source);
    assert.equal(request.timeoutMs, thinking ? 90000 : 30000, source);
    return request;
  }
  try {
    loop.resume();
    (await expectRequest('resume', false)).answer(plain);
    loop.wake('idle self-goal');
    (await expectRequest('idle self-goal', false)).answer(failedTool('idle-goto'));
    (await expectRequest('tool completion', false)).answer(plain);
    loop.wake('chat');
    (await expectRequest('chat', false)).answer(plain);
    loop.wake('death/respawn');
    (await expectRequest('death/respawn', false)).answer(plain);

    loop.instruction('collect logs');
    (await expectRequest('instruction', true)).answer(failedTool('instruction-goto'));
    (await expectRequest('instruction tool failure', true)).answer(plain);
    // A newer resume must not inherit an already-queued failed-tool replan's thinking privilege.
    loop.wake('instruction tool failure'); loop.resume();
    (await expectRequest('resume', false)).answer(plain);
    loop.wake('chat');
    (await expectRequest('chat', false)).answer(failedTool('chat-goto'));
    (await expectRequest('chat', false)).answer(plain);
    loop.wake('tool completion');
    (await expectRequest('tool completion', false)).answer(plain);

    loop.instruction('remember this place');
    (await expectRequest('instruction', true)).answer({content: null, reasoning: null, toolCalls: [{id: 'successful-note', type: 'function', function: {name: 'remember', arguments: '{"kind":"landmark","name":"Here","note":"A place to revisit."}'}}], usage: {}});
    (await expectRequest('tool completion', false)).answer(plain);
    config.llm.thinking = 'off'; loop.instruction('another terminal task');
    (await expectRequest('instruction', false)).answer(failedTool('off-goto'));
    (await expectRequest('instruction tool failure', false)).answer(plain);
    config.llm.thinking = 'on'; loop.wake('idle self-goal');
    (await expectRequest('idle self-goal', false)).answer(plain);
  } finally {for (const resolve of replies) resolve(plain); await loop.close();}
});

test('a Java reflex pause cancels planning without releasing the body; other pauses release it', async () => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const releases: string[] = [];
  const releaseMethods = new Set(['qc.baritone.stop', 'interact.stopBreaking', 'control.stopUsing', 'nav.stop', 'control.stop']);
  const bridge: Bridge = {
    async health() {return true;},
    async rpc<T>(method: string): Promise<T> {
      if (releaseMethods.has(method)) releases.push(method);
      return {} as T;
    },
  };
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const notes: Notes = {home: null, zones: [], places: []};
  const store: NotesStore = {get() {return notes;}, async update(fn) {fn(notes);}};
  const chat: ChatPolicy = {route() {return {kind: 'ignore'};}, async say() {return {ok: true, summary: 'sent'};}, async reply() {return {ok: true, summary: 'sent'};}};
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  const loop = createLoop({config, bridge, events, notes: store, chat, heuristics, log() {}, record() {}, llm: {async complete() {return {content: 'idle', reasoning: null, toolCalls: [], usage: {}};}}});
  try {
    loop.pause('Java reflex owns controls', {releaseBody: false});
    await delay(30);
    assert.deepEqual(releases, []);
    assert.equal(loop.status().paused, true);
    loop.pause('manual_input');
    for (let i = 0; i < 50 && releases.length < releaseMethods.size; i++) await delay(10);
    assert.deepEqual(new Set(releases), releaseMethods);
  } finally {await loop.close();}
});

test('after history compaction every planning request has exactly one leading system message', {timeout: 10000}, async t => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const bridge: Bridge = {async health() {return true;}, async rpc<T>(): Promise<T> {return {} as T;}};
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const notes: Notes = {home: null, zones: [], places: []};
  const store: NotesStore = {get() {return notes;}, async update(fn) {fn(notes);}};
  const chat: ChatPolicy = {route() {return {kind: 'ignore'};}, async say() {return {ok: true, summary: 'sent'};}, async reply() {return {ok: true, summary: 'sent'};}};
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  const done = Promise.withResolvers<void>();
  t.signal.addEventListener('abort', () => done.reject(new Error('compaction regression cancelled')), {once: true});
  let planning = 0, compactions = 0, summarizedRequests = 0;
  const problems: string[] = [];
  const loop = createLoop({config, bridge, events, notes: store, chat, heuristics, log() {}, record() {}, llm: {
    async complete(messages, tools) {
      if (tools.length === 0) {compactions++; return {content: 'Earlier: recalled notes several times.', reasoning: null, toolCalls: [], usage: {}};}
      planning++;
      const systemAt = messages.flatMap((message, i) => message.role === 'system' ? [i] : []);
      if (systemAt.length !== 1 || systemAt[0] !== 0) problems.push(`request ${planning}: system messages at ${JSON.stringify(systemAt)}`);
      const first = messages[0];
      if (first && first.role === 'system' && typeof first.content === 'string' && first.content.includes('Prior observed context')) summarizedRequests++;
      if (summarizedRequests >= 2 || planning >= 40) {done.resolve(); return {content: 'done', reasoning: null, toolCalls: [], usage: {}};}
      return {content: null, reasoning: null, usage: {}, toolCalls: [{id: `recall-${planning}`, type: 'function', function: {name: 'recall', arguments: '{"query":"home"}'}}]};
    },
  }});
  try {
    loop.instruction('keep recalling notes'); loop.resume();
    await done.promise;
    assert.deepEqual(problems, []);
    assert.ok(compactions >= 1);
    assert.ok(summarizedRequests >= 2);
  } finally {await loop.close();}
});
