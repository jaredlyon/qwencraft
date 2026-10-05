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
import type { Bridge, ChatEvent, ChatMessage, ChatPolicy, Events, GameEvent, HeuristicsHost, LlmReply, Notes, NotesStore, RpcOptions, ToolDef } from '../types.ts';

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
  const second = Promise.withResolvers<LlmReply>();
  let calls = 0, running = 0, peak = 0;
  const loop = createLoop({config, bridge, events, notes: store, chat, heuristics, log() {}, record(kind) {records.push(kind);}, llm: {async complete() {
    calls++; running++; peak = Math.max(peak, running);
    try {
      if (calls === 1) return await first.promise;
      return await second.promise;
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
    loop.pause('manual_input'); assert.equal(loop.status().paused, true);
  } finally {first.resolve({content: 'settled', reasoning: null, toolCalls: [], usage: {}}); second.resolve({content: 'settled', reasoning: null, toolCalls: [], usage: {}}); await loop.close();}
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
      [{id: 'hud-finish', type: 'function', function: {name: 'finish_goal', arguments: '{"summary":"abandoned: HUD regression"}'}}] : []};
  }}});
  try {
    loop.instruction('close this goal'); loop.resume();
    await Promise.race([idle.promise, cancelled.promise]);
    assert.deepEqual(hudUpdates.filter(update => 'status' in update).map(update => update.status), ['Waiting for Qwen', 'Running finish_goal', 'Waiting for Qwen', 'Idle']);
    assert.deepEqual(hudUpdates.filter(update => 'action' in update).map(update => update.action), ['finish_goal {"summary":"abandoned: HUD regression"}', 'finish_goal: done, Goal closure requested against recorded outcomes, not inferred achievement']);
    assert.ok(hudUpdates.every(update => !('thought' in update)));
    assert.ok(hudUpdates.filter(update => update.status === 'Waiting for Qwen' || update.status === 'Idle').every(update => !('action' in update)));
    assert.ok(hudUpdates.filter(update => typeof update.action === 'string' && update.action.startsWith('finish_goal: done')).every(update => !('status' in update)));
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

interface LaneRequest {
  messages: ChatMessage[]; tools: ToolDef[]; thinking: boolean; timeoutMs: number; answer(reply: LlmReply): void; fail(error: Error): void;
}
function chatLoopFixture(signal: AbortSignal) {
  const config = loadConfig(DEFAULT_CONFIG_PATH); config.home = null;
  const state: Notes = {home: null, zones: [], places: []};
  const notes: NotesStore = {get() {return state;}, async update(fn) {fn(state);}};
  const bridge: Bridge = {
    async health() {return true;},
    async rpc<T>(method: string): Promise<T> {
      const responses: Record<string, unknown> = {
        'qc.control.state': {paused: false}, 'player.getState': {x: 0, y: 64, z: 0, health: 20, food: 20, dimension: 'minecraft:overworld'},
        'player.getInventory': {hotbar: [], main: [], armor: [], offhand: {}}, 'player.getEquipment': {}, 'player.getStatusEffects': {effects: []},
        'perception.entities': {entities: []}, 'perception.scan': {chunks: [], pois: []}, 'qc.world.state': {dimension: 'minecraft:overworld'},
        'qc.baritone.status': {active: false}, 'session.info': {worldId: 'test', dimension: 'minecraft:overworld'},
      };
      return (responses[method] ?? {}) as T;
    },
  };
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const sent: Array<{to: string | null; text: string; privately?: boolean}> = [];
  const chat: ChatPolicy = {
    route() {return {kind: 'ignore'};},
    async say(text) {sent.push({to: null, text}); return {ok: true, summary: 'sent'};},
    async reply(to, text, privately) {sent.push({to, text, privately}); return {ok: true, summary: 'sent'};},
  };
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  const records: Array<{kind: string; data: Record<string, unknown>}> = [], logs: string[] = [];
  const requests: LaneRequest[] = [], waiters: Array<(request: LaneRequest) => void> = [], replies: Array<(reply: LlmReply) => void> = [];
  const cancelled = Promise.withResolvers<never>();
  signal.addEventListener('abort', () => cancelled.reject(new Error('Chat regression cancelled')), {once: true});
  let clock = 1000;
  const loop = createLoop({config, bridge, events, notes, chat, heuristics, now: () => clock,
    log(message) {logs.push(message);}, record(kind, data) {records.push({kind, data});},
    llm: {async complete(messages, tools, opts) {
      const reply = Promise.withResolvers<LlmReply>(); replies.push(reply.resolve);
      const request: LaneRequest = {messages: [...messages], tools, thinking: opts.thinking, timeoutMs: opts.timeoutMs, answer: reply.resolve, fail: reply.reject};
      const waiter = waiters.shift();
      if (waiter) waiter(request); else requests.push(request);
      return reply.promise;
    }},
  });
  return {loop, notes, sent, records, logs, requests,
    advance(ms: number) {clock += ms;},
    async next() {
      const queued = requests.shift(); if (queued) return queued;
      const pending = Promise.withResolvers<LaneRequest>(); waiters.push(pending.resolve);
      return Promise.race([pending.promise, cancelled.promise]);
    },
    async close() {loop.pause('test finished'); replies.forEach(resolve => resolve({content: null, reasoning: null, toolCalls: [], usage: {}})); await loop.close();},
  };
}
function lanePayload(request: LaneRequest): Record<string, unknown> {
  const message = request.messages.find(message => message.role === 'user');
  assert.ok(message && typeof message.content === 'string');
  return JSON.parse(message.content) as Record<string, unknown>;
}
function laneReply(...calls: Array<{name: string; args: Record<string, unknown>}>): LlmReply {
  return {content: null, reasoning: null, usage: {}, toolCalls: calls.map((call, i) => ({
    id: `call-${i}`, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.args)},
  }))};
}
function incoming(id: number, extra: Partial<ChatEvent> = {}): ChatEvent {
  return {id, kind: 'player', senderName: 'Alex', senderUuid: 'alex', text: 'Jared, how is it going?', self: false, signed: false, mentionsMe: true, ...extra};
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), 'expected asynchronous lane outcome');
}

test('chat replies independently while a body tool is blocked; lane histories and tools stay separate', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal), toolStarted = Promise.withResolvers<void>(), releaseTool = Promise.withResolvers<void>();
  f.notes.update = async fn => {toolStarted.resolve(); await releaseTool.promise; fn(f.notes.get());};
  try {
    f.loop.instruction('remember this place'); f.loop.resume();
    const body = await f.next();
    assert.ok(body.tools.every(tool => !['chat_say', 'chat_reply'].includes(tool.name)));
    assert.equal('mustReply' in lanePayload(body), false);
    body.answer(laneReply({name: 'remember', args: {kind: 'landmark', name: 'Here', note: 'A place.'}}));
    await toolStarted.promise;
    f.loop.wake('chat', incoming(1));
    const first = await f.next();
    assert.equal(first.messages.length, 2); assert.equal(first.thinking, false); assert.equal(first.timeoutMs, 30000);
    assert.deepEqual(first.tools.map(tool => tool.name).sort(), ['chat_reply', 'chat_say', 'harness_info', 'observe']);
    assert.deepEqual(lanePayload(first).mustReply, [{id: 1, from: 'Alex', kind: 'player', text: 'Jared, how is it going?'}]);
    assert.equal((lanePayload(first).live as Record<string, unknown>).currentAction, 'remember');
    first.answer(laneReply({name: 'harness_info', args: {question: 'What agent am I?'}}));
    const second = await f.next(); assert.ok(second.messages.some(message => message.role === 'tool'));
    second.answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'I am remembering a place.'}}));
    await waitFor(() => f.sent.length === 1 && !f.loop.status().chatModel);
    assert.equal(f.loop.status().skill, 'remember');
    releaseTool.resolve();
    const continuedBody = await f.next();
    assert.ok(continuedBody.tools.every(tool => !['chat_say', 'chat_reply'].includes(tool.name)));
    assert.ok(!continuedBody.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function.name === 'chat_reply')));
    f.loop.pause('inspect body history'); continuedBody.answer(laneReply());
  } finally {releaseTool.resolve(); await f.close();}
});

for (const kind of ['player', 'whisper'] as const) test(`${kind} replies open a case-insensitive five-minute conversation window`, {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.wake('chat', incoming(1, {kind, mentionsMe: kind === 'player'})); f.loop.resume();
    const first = await f.next();
    first.answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'Hello!'}}));
    await waitFor(() => f.sent.length === 1 && !f.loop.status().chatModel);
    assert.equal(f.sent[0]?.privately, true);
    f.advance(300000);
    f.loop.wake('chat', incoming(2, {senderName: 'aLeX', text: 'And how does that work?', mentionsMe: false}));
    const followUp = await f.next();
    assert.deepEqual(lanePayload(followUp).mustReply, []);
    assert.deepEqual(lanePayload(followUp).followUps, [{id: 2, from: 'aLeX', kind: 'player', text: 'And how does that work?'}]);
    followUp.answer(laneReply({name: 'chat_say', args: {text: 'Here is how it works.'}}));
    await waitFor(() => f.sent.length === 2 && !f.loop.status().chatModel);
    f.advance(300001);
    f.loop.wake('chat', incoming(3, {text: 'And now?', mentionsMe: false}));
    await delay(20); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 2);
    assert.deepEqual(f.loop.status().pendingWakes, []);
  } finally {await f.close();}
});

test('history, self and system chat never wake a reply or body turn; history remains context', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.wake('chat history', incoming(1)); f.loop.wake('chat history', incoming(2, {kind: 'whisper'}));
    f.loop.wake('chat', incoming(3, {self: true})); f.loop.wake('chat', incoming(4, {kind: 'system'}));
    f.loop.resume(); await delay(20);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.loop.status().pendingWakes, []);
    f.loop.wake('chat', incoming(5)); const live = await f.next();
    assert.deepEqual(lanePayload(live).mustReply, [{id: 5, from: 'Alex', kind: 'player', text: 'Jared, how is it going?'}]);
    assert.deepEqual((lanePayload(live).recentChat as Array<{id: number}>).map(event => event.id), [1, 2, 3, 4, 5]);
    live.answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'Hello!'}}));
    await waitFor(() => f.sent.length === 1);
  } finally {await f.close();}
});

test('chat tools are rejected outside addressed chat, including after a lane has answered its entries', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  const rejected = {ok: false, summary: 'chat is only for replying to a message that mentions you'};
  try {
    f.loop.instruction('do not send unsolicited chat'); f.loop.resume();
    const body = await f.next();
    body.answer(laneReply({name: 'chat_say', args: {text: 'Unsolicited.'}}, {name: 'chat_reply', args: {to: 'Alex', text: 'Unsolicited.'}}));
    const bodyAgain = await f.next(); f.loop.pause('body rejection inspected'); bodyAgain.answer(laneReply());
    assert.deepEqual(f.records.filter(record => record.kind === 'tool_result').map(record => record.data.result), [rejected, rejected]);
    assert.deepEqual(f.sent, []);
    f.loop.restore({instruction: null, goals: []});
    f.loop.wake('chat', incoming(1)); f.loop.resume();
    const request = await f.next();
    request.answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'Hello!'}}, {name: 'chat_say', args: {text: 'Unsolicited extra.'}}));
    await waitFor(() => !f.loop.status().chatModel);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.records.filter(record => record.kind === 'tool_result').at(-1)?.data.result, rejected);
  } finally {await f.close();}
});

test('new addressed entries rerun immediately with at most one chat request in flight', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.resume(); f.loop.wake('chat', incoming(1)); const first = await f.next();
    f.loop.wake('chat', incoming(2, {senderName: 'Sam'})); await delay(20);
    assert.equal(f.requests.length, 0);
    first.answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'Hello Alex!'}}));
    const second = await f.next();
    assert.deepEqual(lanePayload(second).mustReply, [{id: 2, from: 'Sam', kind: 'player', text: 'Jared, how is it going?'}]);
    assert.equal(second.messages.length, 2);
    second.answer(laneReply({name: 'chat_reply', args: {to: 'Sam', text: 'Hello Sam!'}}));
    await waitFor(() => f.sent.length === 2 && !f.loop.status().chatModel);
  } finally {await f.close();}
});

test('mustReply retries twice at five-second intervals with a nudge, then logs the dropped entry', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.resume(); f.loop.wake('chat', incoming(1));
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = await f.next();
      assert.equal(lanePayload(request).nudge, attempt ? 'You did not answer these mustReply entries; answer them now.' : undefined);
      request.answer(laneReply()); await waitFor(() => !f.loop.status().chatModel);
      if (attempt < 2) {
        f.advance(4999); f.loop.wake('chat'); await delay(10); assert.equal(f.requests.length, 0);
        f.advance(1); f.loop.wake('chat');
      }
    }
    assert.ok(f.logs.includes('Unanswered chat dropped: Alex: Jared, how is it going?'));
    f.advance(5000); f.loop.wake('chat'); await delay(10); assert.equal(f.requests.length, 0);
  } finally {await f.close();}
});

test('paused mustReply expires at 120 seconds and follow-ups expire with their conversation window', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.wake('chat', incoming(1)); f.advance(120000); f.loop.resume(); await delay(20);
    assert.equal(f.requests.length, 0);
    f.loop.wake('chat', incoming(2)); (await f.next()).answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'Hello!'}}));
    await waitFor(() => f.sent.length === 1 && !f.loop.status().chatModel);
    f.loop.pause('manual input'); f.loop.wake('chat', incoming(3, {mentionsMe: false}));
    await delay(10); assert.equal(f.requests.length, 0);
    f.advance(300001); f.loop.resume(); await delay(20); assert.equal(f.requests.length, 0);
  } finally {await f.close();}
});

test('a chat lane allows at most three tool rounds and never dispatches gameplay', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.resume(); f.loop.wake('chat', incoming(1));
    for (let round = 0; round < 3; round++) {
      const request = await f.next();
      assert.equal(request.messages.filter(message => message.role === 'system').length, 1);
      assert.equal(request.messages.filter(message => message.role === 'tool').length, round);
      request.answer(laneReply({name: 'go_to', args: {x: 1, z: 1}}));
    }
    await waitFor(() => !f.loop.status().chatModel);
    assert.equal(f.requests.length, 0); assert.equal(f.loop.status().skill, null); assert.equal(f.sent.length, 0);
    assert.deepEqual(f.records.filter(record => record.kind === 'tool_result').map(record => record.data.result),
      Array.from({length: 3}, () => ({ok: false, summary: 'Chat is conversation only; gameplay requires the local terminal'})));
  } finally {await f.close();}
});

test('an LLM failure retries addressed chat without waiting on the body lane', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.resume(); f.loop.wake('chat', incoming(1)); (await f.next()).fail(new Error('request timed out'));
    await waitFor(() => !f.loop.status().chatModel);
    assert.ok(f.logs.includes('Chat lane failure: request timed out'));
    f.advance(5000); f.loop.wake('chat'); const retry = await f.next();
    assert.equal(lanePayload(retry).nudge, 'You did not answer these mustReply entries; answer them now.');
    retry.answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'Sorry, here is my answer.'}}));
    await waitFor(() => f.sent.length === 1 && !f.loop.status().chatModel);
  } finally {await f.close();}
});

test('expired addressed entries cannot authorize a stale lane chat tool', {timeout: 5000}, async t => {
  const f = chatLoopFixture(t.signal);
  try {
    f.loop.resume(); f.loop.wake('chat', incoming(1)); const stale = await f.next();
    f.advance(120000);
    stale.answer(laneReply({name: 'chat_reply', args: {to: 'Alex', text: 'Too late.'}}));
    await waitFor(() => !f.loop.status().chatModel);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.records.filter(record => record.kind === 'tool_result').at(-1)?.data.result,
      {ok: false, summary: 'chat is only for replying to a message that mentions you'});
  } finally {await f.close();}
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
    (await expectRequest('continue', false)).answer(failedTool('self-goto'));
    (await expectRequest('tool completion', false)).answer(plain);
    const selfPlanning = await expectRequest('continue', false);
    loop.instruction('collect logs'); selfPlanning.answer(plain);
    (await expectRequest('instruction', true)).answer(failedTool('instruction-goto'));
    (await expectRequest('instruction tool failure', true)).answer(plain);
    const instructionPlanning = await expectRequest('continue', false);
    // Resume must not inherit the failed-tool thinking privilege.
    loop.wake('instruction tool failure'); loop.resume(); instructionPlanning.answer(plain);
    (await expectRequest('resume', false)).answer(plain);
    const resumedPlanning = await expectRequest('continue', false);
    loop.pause('chat no longer wakes body'); loop.restore({instruction: null, goals: []});
    config.home = null; state.home = null; loop.wake('chat'); loop.resume(); resumedPlanning.answer(plain);
    loop.instruction('remember this place');
    (await expectRequest('instruction', true)).answer({content: null, reasoning: null, toolCalls: [{id: 'successful-note', type: 'function', function: {name: 'remember', arguments: '{"kind":"landmark","name":"Here","note":"A place to revisit."}'}}], usage: {}});
    (await expectRequest('tool completion', false)).answer(plain);
    const notePlanning = await expectRequest('continue', false);
    config.llm.thinking = 'off'; loop.instruction('another terminal task'); notePlanning.answer(plain);
    (await expectRequest('instruction', false)).answer(failedTool('off-goto'));
    (await expectRequest('instruction tool failure', false)).answer(plain);
    config.llm.thinking = 'on';
    (await expectRequest('continue', false)).answer(plain);
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

for (const mode of ['instruction', 'home', 'none'] as const) test(`no-tool reply ${mode === 'none' ? 'idles without a goal or home' : `continues with ${mode}`}`, {timeout: 5000}, async t => {
  const config = loadConfig(DEFAULT_CONFIG_PATH); config.home = null;
  const state: Notes = {home: mode === 'home' ? [0,64,0] : null, zones: [], places: []};
  const notes: NotesStore = {get() {return state;}, async update(fn) {fn(state);}};
  const bridge: Bridge = {async health() {return true;}, async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'qc.hud.set' && params.status === 'Idle') idle.resolve();
    const responses: Record<string, unknown> = {
      'qc.control.state': {paused: false}, 'player.getState': {x: 0,y: 64,z: 0,health: 20,food: 20,dimension: 'minecraft:overworld'},
      'player.getInventory': {hotbar: [], main: [], armor: [], offhand: {}}, 'player.getEquipment': {}, 'player.getStatusEffects': {effects: []},
      'perception.entities': {entities: []}, 'perception.scan': {chunks: [], pois: []}, 'qc.world.state': {dimension: 'minecraft:overworld'},
      'qc.baritone.status': {active: false}, 'session.info': {worldId: 'test', dimension: 'minecraft:overworld'},
    };
    return (responses[method] ?? {}) as T;
  }};
  const events: Events = {on() {return () => {};}, async next() {return null;}};
  const chat: ChatPolicy = {route() {return {kind: 'ignore'};}, async say() {return {ok: true, summary: 'sent'};}, async reply() {return {ok: true, summary: 'sent'};}};
  const heuristics: HeuristicsHost = {onObservation() {return [];}, onPlanProposed(call) {return call;}, onTick() {return undefined;}, onChat() {return undefined;}, names() {return [];}, close() {}};
  const idle = Promise.withResolvers<void>(), continued = Promise.withResolvers<Record<string, unknown>>();
  const pending = Promise.withResolvers<LlmReply>(), cancelled = Promise.withResolvers<never>();
  const plain: LlmReply = {content: 'Considering the goal.', reasoning: null, usage: {}, toolCalls: []};
  t.signal.addEventListener('abort', () => cancelled.reject(new Error('no-tool regression cancelled')), {once: true});
  let requests = 0;
  const loop = createLoop({config, bridge, events, notes, chat, heuristics, log(message) {
    if (message.startsWith('Loop failure:')) cancelled.reject(new Error(message));
  }, record() {}, llm: {async complete(messages) {
    requests++;
    if (requests === 1) {
      assert.ok(messages.some(message => message.role === 'system' && typeof message.content === 'string' && message.content.includes('Every reply must contain at least one tool call')));
      return plain;
    }
    const current = messages.findLast(message => message.role === 'user' && typeof message.content === 'string');
    assert.ok(current && typeof current.content === 'string');
    continued.resolve(JSON.parse(current.content) as Record<string, unknown>);
    return pending.promise;
  }}});
  try {
    // Goal state is copied both ways, does not schedule work, and restores the innermost goal.
    const restored = {instruction: 'find iron', goals: ['find iron', 'make a pickaxe']};
    loop.restore(restored); restored.goals.push('not restored');
    assert.deepEqual(loop.snapshot(), {instruction: 'find iron', goals: ['find iron', 'make a pickaxe']});
    const snapshot = loop.snapshot();
    loop.restore({instruction: null, goals: []}); loop.restore(snapshot);
    assert.deepEqual(loop.snapshot(), snapshot);
    snapshot.goals.push('not saved');
    assert.deepEqual(loop.snapshot().goals, ['find iron', 'make a pickaxe']);
    assert.equal(loop.status().goal, 'make a pickaxe'); assert.deepEqual(loop.status().pendingWakes, []);
    loop.restore({instruction: 'root goal', goals: []}); assert.equal(loop.status().goal, 'root goal');
    loop.restore({instruction: null, goals: []});
    if (mode === 'instruction') loop.instruction('find iron');
    loop.resume();
    if (mode === 'none') {
      loop.wake('observation');
      await Promise.race([idle.promise, cancelled.promise]);
      await delay(20);
      assert.equal(requests, 1); assert.deepEqual(loop.status().pendingWakes, []);
    } else {
      const payload = await Promise.race([continued.promise, cancelled.promise]);
      assert.deepEqual(payload.wakeSources, ['continue']);
      assert.equal(payload.nudge, 'Your previous reply had no tool call. Choose the next action now, or call finish_goal.');
      assert.equal(requests, 2);
    }
  } finally {pending.resolve(plain); await loop.close();}
});
