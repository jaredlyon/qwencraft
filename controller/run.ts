import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig, toConfigApply, DEFAULT_CONFIG_PATH } from './config.ts';
import { createBridge } from './bridge.ts';
import { createEvents } from './events.ts';
import { createLlm } from './llm.ts';
import { createLoop } from './loop.ts';
import { print, startConsole } from './console.ts';
import { createHeuristics } from './heuristics.ts';
import { createNotesStore } from './memory.ts';
import { createChatPolicy } from './chat-policy.ts';
import { redact } from './selfinfo.ts';
import type { ChatEvent, Config, Ctx, GameEvent, Vec3 } from './types.ts';
import { RESTART_EXIT_CODE } from './types.ts';

export function readRestartState(path: string, now: number): {instruction: string | null; goals: string[]; active: boolean} | null {
  if (!existsSync(path)) return null;
  try {
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const saved = state as Record<string, unknown>;
    if (typeof saved.savedAt !== 'number' || !Number.isFinite(saved.savedAt) || saved.savedAt > now || now - saved.savedAt > 600000
      || !(saved.instruction === null || typeof saved.instruction === 'string')
      || !Array.isArray(saved.goals) || !saved.goals.every((goal: unknown) => typeof goal === 'string')
      || typeof saved.active !== 'boolean') return null;
    return {instruction: saved.instruction, goals: saved.goals as string[], active: saved.active};
  } catch {
    return null;
  } finally {
    unlinkSync(path);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1])) throw new Error('Usage: node main.ts [--config <path>]');
  const config = loadConfig(args[1] ?? DEFAULT_CONFIG_PATH);
  mkdirSync(config.paths.transcriptDir, {recursive: true});
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  const transcript = join(config.paths.transcriptDir, `${run}.jsonl`);
  function record(kind: string, data: Record<string, unknown>) {
    if (kind === 'screenshot' && typeof data.image === 'string' && data.image.startsWith('data:image/png;base64,')) {
      const reference = `${run}-${Date.now()}.png`;
      writeFileSync(join(config.paths.transcriptDir, reference), Buffer.from(data.image.slice('data:image/png;base64,'.length), 'base64'));
      data = {...data, image: reference};
    }
    appendFileSync(transcript, JSON.stringify({at: new Date().toISOString(), kind, ...data}, (key, value: unknown) => ['token','reasoning','reasoning_content','password','base64'].includes(key) ? '[omitted]' : value) + '\n');
  }
  function log(message: string) {print(message); record('console', {message});}
  log('Waiting for Minecraft bridge...');
  const bridge = await createBridge(config);
  while (!(await bridge.health())) await delay(1000);
  const status = await bridge.rpc<{side: string; methods: string[]}>('info.status');
  const capabilities = await bridge.rpc<{groups: Record<string, boolean>}>('info.capabilities');
  const required = ['qc.config.apply','qc.control.state','qc.control.lease','qc.control.pause','qc.control.resume','qc.chat.send','qc.hud.set','qc.world.state','qc.baritone.goto','qc.baritone.mine','qc.baritone.follow','qc.baritone.explore','qc.baritone.stop','qc.baritone.status','qc.session.connect','qc.session.respawn'];
  if (status.side !== 'client' || !Array.isArray(status.methods)) throw new Error('Bridge must be a Minecraft client');
  for (const method of required) if (!status.methods.includes(method)) throw new Error(`Companion method missing: ${method}`);
  if (!capabilities.groups.control || !capabilities.groups.vision || capabilities.groups.command || capabilities.groups.world_write) throw new Error('Unsafe bridge capabilities: require control/vision; disable commands/world writes');
  await bridge.rpc('qc.control.pause', {reason: 'console'});
  await bridge.rpc('qc.config.apply', toConfigApply(config));
  await bridge.rpc('qc.control.state');
  const lifetime = new AbortController();
  const events = createEvents(bridge, config, lifetime.signal);
  const bootEvents: GameEvent[] = [];
  const offBootstrap = events.on('*', event => {bootEvents.push(event);});
  const heuristics = await createHeuristics(config.paths.heuristicsDir, log);
  const notes = await createNotesStore(config.paths.notesFile, config);
  const context = (): Ctx => ({config: config as unknown as Record<string, unknown>, notes: notes.get() as unknown as Record<string, unknown>, log, now: Date.now});
  const chat = createChatPolicy(config, bridge, heuristics, context);
  const loop = createLoop({config, bridge, events, notes, chat, heuristics, llm: createLlm(config), log, record});
  const restartPath = join(dirname(config.paths.notesFile), 'controller-restart.json');
  const hadRestartState = existsSync(restartPath);
  const restartState = readRestartState(restartPath, Date.now());
  if (restartState) loop.restore(restartState);
  else if (hadRestartState) log('Ignored malformed or stale controller restart state.');
  let connected = false, operatorPaused = true, activated = false, shuttingDown = false, homeAttempted = false;
  let lifecycle = new AbortController(), reconnectAttempts = 0, reconnectLatch = false, reconnectBusy = false, activating = false;
  let stable: NodeJS.Timeout | undefined;
  let reflexTimer: NodeJS.Timeout | undefined;
  let lastReflexAt = 0;
  let closeConsole = () => {};
  const handleError = (error: unknown) => log(error instanceof Error ? error.message : 'Operation failed');
  async function pushConfig() {
    const merged = new Map(config.protect.zones.map(zone => [zone.name, zone]));
    for (const zone of notes.get().zones) merged.set(zone.name, zone);
    const effective: Config = {...config, home: notes.get().home ?? config.home, protect: {...config.protect, zones: [...merged.values()]}};
    await bridge.rpc('qc.config.apply', toConfigApply(effective));
  }
  async function player(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const state = await bridge.rpc<Record<string, unknown>>('player.getState', {}, {signal});
    signal?.throwIfAborted();
    if (![state.x,state.y,state.z].every(value => typeof value === 'number' && Number.isFinite(value)) || typeof state.dimension !== 'string') throw new Error('Player position/dimension unavailable');
    return {pos: [state.x,state.y,state.z] as Vec3, dimension: state.dimension};
  }
  async function verifySession(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const session = await bridge.rpc<{worldId: string; dimension: string}>('session.info', {}, {signal});
    signal?.throwIfAborted();
    const host = config.server.host.toLowerCase();
    const accepted = [`mp:${host}:${config.server.port}`, ...(config.server.port === 25565 ? [`mp:${host}`] : [])];
    if (!accepted.includes(session.worldId)) throw new Error('Client is not joined to the configured server; controller stays paused');
    await player(signal);
    await bridge.rpc('player.getInventory', {}, {signal}); signal?.throwIfAborted();
    await bridge.rpc('qc.baritone.status', {}, {signal}); signal?.throwIfAborted();
    return session;
  }
  function stability() {
    clearTimeout(stable);
    stable = setTimeout(() => {if (connected) {reconnectAttempts = 0; reconnectLatch = false; log('Reconnect allowance reset after one hour continuously connected');}}, 3600000);
  }
  function cancelLifecycle() {lifecycle.abort(); lifecycle = new AbortController(); clearTimeout(stable);}
  async function resolveHome(signal: AbortSignal) {
    if ((notes.get().home ?? config.home) || homeAttempted) return;
    homeAttempted = true;
    const before = await player();
    let denied = false;
    const off = events.on('qc.chat', event => {if (event.data && typeof event.data === 'object' && 'text' in event.data && typeof event.data.text === 'string' && /unknown command|no home|no permission|cannot teleport|teleport.*denied/i.test(event.data.text)) denied = true;});
    try {
      const sent = await bridge.rpc<{sent: boolean}>('qc.chat.send', {text: '/home'}, {signal});
      if (!sent.sent) {log('set home with `home set`'); return;}
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !signal.aborted && !operatorPaused && connected) {
        if (denied) break;
        await delay(250, undefined, {signal});
        const arrival = await player();
        const changed = arrival.dimension !== before.dimension || Math.hypot(arrival.pos[0] - before.pos[0], arrival.pos[1] - before.pos[1], arrival.pos[2] - before.pos[2]) > 1;
        if (!changed) continue;
        // Require a second stable snapshot rather than recording the command acknowledgement as arrival.
        await delay(500, undefined, {signal});
        const settled = await player();
        if (settled.dimension !== arrival.dimension || Math.hypot(...settled.pos.map((n, i) => n - arrival.pos[i]!) as Vec3) > 0.25) continue;
        if (signal.aborted || operatorPaused || !connected) return;
        await notes.update(n => {n.home = settled.pos; n.places.push({kind: 'home', name: 'home', note: `Observed /home arrival on configured server`, pos: settled.pos, dimension: settled.dimension, at: Date.now()});});
        log(`Home recorded: ${settled.pos.join(', ')} (${settled.dimension})`); await pushConfig(); return;
      }
      if (!signal.aborted) log('set home with `home set`');
    } finally {off();}
  }
  async function activate() {
    if (activating || operatorPaused || !connected || shuttingDown) return;
    activating = true; const signal = lifecycle.signal;
    try {
      await verifySession(); await pushConfig();
      await bridge.rpc('qc.control.lease', {ttlMs: config.lease.ttlMs});
      const control = await bridge.rpc<{paused: boolean}>('qc.control.state');
      if (control.paused || operatorPaused || signal.aborted) return;
      activated = true;
      await resolveHome(signal);
      if (!operatorPaused && !signal.aborted) loop.resume();
    } finally {
      activating = false;
      if (signal.aborted && !operatorPaused && connected && !shuttingDown) void activate().catch(handleError);
    }
  }
  async function reconnect() {
    if (reconnectBusy || connected || operatorPaused || reconnectLatch || shuttingDown) return;
    reconnectBusy = true; const signal = lifecycle.signal;
    try {
      while (!connected && !operatorPaused && !signal.aborted && !reconnectLatch) {
        if (reconnectAttempts >= config.reconnect.maxPerHour) {reconnectLatch = true; log('Reconnect limit reached; type resume to rearm'); break;}
        const backoff = config.reconnect.backoffMs[Math.min(reconnectAttempts, config.reconnect.backoffMs.length - 1)]!;
        await delay(backoff, undefined, {signal});
        if (connected || operatorPaused || signal.aborted) break;
        reconnectAttempts++; record('reconnect_attempt', {attempt: reconnectAttempts});
        try {await bridge.rpc('qc.session.connect', config.server, {signal});} catch (error) {handleError(error); continue;}
        const joined = await events.next('qc.join', () => true, 20000, signal);
        if (joined || connected) break;
        try {await verifySession(); connected = true; stability(); await activate(); break;} catch {log('Reconnect did not produce a verified joined session');}
      }
    } catch (error) {if (!signal.aborted) handleError(error);} finally {reconnectBusy = false;}
  }
  async function stop() {
    operatorPaused = true; cancelLifecycle(); loop.pause('console');
    await bridge.rpc('qc.control.pause', {reason: 'console'}).catch(handleError);
  }
  async function resume() {
    if (shuttingDown) return;
    cancelLifecycle(); operatorPaused = false;
    const signal = lifecycle.signal;
    if (reconnectLatch) {reconnectLatch = false; reconnectAttempts = 0;}
    try {
      await bridge.rpc('qc.control.lease', {ttlMs: config.lease.ttlMs}, {signal});
      if (signal.aborted || operatorPaused || shuttingDown) return;
      await bridge.rpc('qc.control.resume', {}, {signal});
      if (signal.aborted || operatorPaused || shuttingDown) return;
      try {
        await verifySession(signal);
        if (signal.aborted || operatorPaused || shuttingDown) return;
        connected = true; stability();
      } catch (error) {
        if (signal.aborted || operatorPaused || shuttingDown) return;
        connected = false;
      }
      if (signal.aborted || operatorPaused || shuttingDown) return;
      if (connected) await activate(); else void reconnect();
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    await stop(); lifetime.abort(); clearInterval(lease); clearTimeout(reflexTimer); closeConsole(); heuristics.close(); await loop.close();
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
    record('shutdown', {});
  }
  async function restart() {
    if (shuttingDown) return;
    mkdirSync(dirname(restartPath), {recursive: true});
    writeFileSync(restartPath, JSON.stringify({savedAt: Date.now(), ...loop.snapshot(), active: !operatorPaused}));
    log('Restarting controller (code, config and heuristics reload; Java mod changes still need a Minecraft restart).');
    await shutdown();
    process.exitCode = RESTART_EXIT_CODE;
  }
  const signalStop = () => {void shutdown().catch(handleError);};
  process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop);
  function data(event: GameEvent): Record<string, unknown> {return event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as Record<string, unknown> : {};}
  function handleEvent(event: GameEvent) {
    record('event', {event});
    const payload = data(event);
    switch (event.type) {
      case 'qc.chat': {
        if (!['player','system','whisper'].includes(String(payload.kind)) || typeof payload.text !== 'string' || typeof payload.self !== 'boolean' || typeof payload.mentionsMe !== 'boolean' || typeof payload.signed !== 'boolean') return;
        const message: ChatEvent = {id: event.id, kind: payload.kind as ChatEvent['kind'], senderUuid: typeof payload.senderUuid === 'string' ? payload.senderUuid : null, senderName: typeof payload.senderName === 'string' ? payload.senderName : null, text: payload.text, self: payload.self, mentionsMe: payload.mentionsMe, signed: payload.signed};
        const route = chat.route(message);
        if (route.kind === 'model') loop.wake('chat', message);
        else if (route.kind === 'reply') void chat.say(route.text).catch(handleError);
        break;
      }
      case 'qc.pause':
        if (payload.paused === true) {
          loop.pause(String(payload.reason)); lifecycle.abort();
          if (payload.reason === 'hotkey' || payload.reason === 'manual_input') operatorPaused = true;
        } else if (payload.paused === false && activated && connected && !shuttingDown) {
          const owner = lifecycle;
          void bridge.rpc<{paused: boolean}>('qc.control.state').then(control => {
            if (control.paused || shuttingDown || owner !== lifecycle) return;
            if (operatorPaused) {operatorPaused = false; lifecycle = new AbortController();}
            return activate();
          }).catch(handleError);
        }
        break;
      case 'qc.death': {
        loop.pause('death'); lifecycle.abort(); lifecycle = new AbortController();
        const owner = lifecycle.signal;
        void (async () => {
          const pos = [payload.x,payload.y,payload.z];
          if (pos.every(v => typeof v === 'number' && Number.isFinite(v))) await notes.update(n => {n.places.push({kind: 'death', name: `death-${Date.now()}`, note: typeof payload.message === 'string' ? payload.message : 'death', pos: pos as Vec3, dimension: null, at: Date.now()});});
          if (operatorPaused || !connected || owner.aborted) return;
          await bridge.rpc('qc.session.respawn', {}, {signal: owner});
          for (let i = 0; i < 20 && !owner.aborted; i++) {try {await verifySession(); await activate(); return;} catch {await delay(250, undefined, {signal: owner});}}
        })().catch(handleError);
        break;
      }
      case 'qc.disconnect':
        if (!connected) break;
        connected = false; cancelLifecycle(); loop.pause('disconnect');
        if (config.reconnect.stopPatterns.some(pattern => String(payload.reason).toLowerCase().includes(pattern.toLowerCase()))) {reconnectLatch = true; log('Automatic reconnect suppressed by disconnect reason; type resume to rearm');}
        else void reconnect();
        break;
      case 'qc.join':
        void (async () => {
          if (payload.host !== config.server.host || payload.port !== config.server.port) {await stop(); log('Unexpected server join; controller paused'); return;}
          await verifySession(); connected = true; stability(); await pushConfig(); await activate();
        })().catch(handleError);
        break;
      case 'controller.history_lost':
        loop.pause('lost event history'); lifecycle.abort();
        log('Lost event history: taking fresh snapshots; type resume to continue');
        operatorPaused = true;
        void Promise.allSettled(['qc.control.state','player.getState','player.getInventory','qc.baritone.status'].map(method => bridge.rpc(method)));
        void bridge.rpc('qc.control.pause', {reason: 'console'}).catch(handleError);
        break;
      case 'qc.reflex': {
        loop.pause('Java reflex owns controls', {releaseBody: false}); lastReflexAt = Date.now(); clearTimeout(reflexTimer);
        const owner = lifecycle.signal;
        const settle = async () => {
          if (owner.aborted || operatorPaused || !connected || shuttingDown) return;
          const state = await bridge.rpc<{usingItem: boolean}>('player.getState');
          if (Date.now() - lastReflexAt < 1500 || state.usingItem !== false) {
            reflexTimer = setTimeout(() => {void settle().catch(handleError);}, 250);
            return;
          }
          // Exact reflex completion remains a live [VERIFY]; the contract supplies only start events.
          await activate();
        };
        reflexTimer = setTimeout(() => {void settle().catch(handleError);}, 1500);
        break;
      }
      // qc.task is consumed by the owned skill; only its verified result wakes planning.
    }
  }
  offBootstrap();
  events.on('*', handleEvent);
  for (const event of bootEvents) handleEvent(event);
  let leaseBusy = false;
  const lease = setInterval(() => {
    if (leaseBusy || shuttingDown || !connected) return;
    leaseBusy = true;
    void bridge.rpc<{paused: boolean; reason: string | null}>('qc.control.lease', {ttlMs: config.lease.ttlMs}).then(control => {
      if (control.paused && loop.status().paused !== true) loop.pause(control.reason ?? 'paused');
    }).catch(() => {loop.pause('bridge unavailable');}).finally(() => {leaseBusy = false;});
  }, config.lease.intervalMs);
  await pushConfig();
  try {await verifySession(); connected = true; stability();} catch {log('No verified configured-server session yet');}
  closeConsole = startConsole({instruction: text => loop.instruction(text), stop, resume, restart,
    async status() {const snapshots = await Promise.allSettled(['qc.control.state','qc.baritone.status','player.getState','session.info'].map(method => bridge.rpc(method))); log(JSON.stringify({loop: loop.status(), snapshots}, null, 2));},
    async homeSet() {
      lifecycle.abort(); lifecycle = new AbortController(); homeAttempted = true;
      const location = await player(); await verifySession();
      await notes.update(n => {n.home = location.pos; n.places.push({kind: 'home', name: 'home', note: 'Operator home set on configured server', pos: location.pos, dimension: location.dimension, at: Date.now()});});
      log(`Home recorded: ${location.pos.join(', ')} (${location.dimension})`); await pushConfig();
      if (!operatorPaused && connected) loop.wake('home configured');
    },
    async zoneAdd(name, min, max) {
      const session = await verifySession();
      await notes.update(n => {
        n.zones = n.zones.filter(z => z.name !== name); n.zones.push({name, min, max});
        n.places = n.places.filter(p => !(p.kind === 'zone' && p.name === name));
        n.places.push({kind: 'zone', name, note: `Operator zone ${JSON.stringify({min, max})} on configured server`, pos: min, dimension: session.dimension, at: Date.now()});
      });
      await pushConfig(); log(`Zone added: ${name}`);
    },
    async zoneRemove(name) {
      if (config.protect.zones.some(z => z.name === name)) throw new Error('Zone exists in config; edit config to remove it');
      await notes.update(n => {n.zones = n.zones.filter(z => z.name !== name); n.places = n.places.filter(p => !(p.kind === 'zone' && p.name === name));});
      await pushConfig(); log(`Zone removed: ${name}`);
    },
    async say(text) {const result = await bridge.rpc('qc.chat.send', {text: redact(text)}); log(JSON.stringify(result));},
    quit: shutdown, error: log,
  });
  if (restartState?.active) {
    log(`Restored after restart: ${restartState.instruction ?? 'self-goal'}; resuming.`);
    await resume().catch(handleError);
  } else if (restartState) log('Restored after restart (paused).');
  else log('Controller PAUSED. Type resume to activate; stop/quit send no chat.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {console.error(error instanceof Error ? error.message : 'Controller startup failed'); process.exitCode = 1;});
}
