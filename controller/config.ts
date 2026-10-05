import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './types.ts';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../qwencraft.config.json', import.meta.url));

export function loadConfig(path: string): Config {
  const absolute = resolve(path);
  const input: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
  const fail = (key: string): never => { throw new Error(`Invalid config key: ${key}`); };
  const object = (v: unknown, key: string, keys: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(key);
    const obj = v as Record<string, unknown>;
    for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(`${key}.${k}`);
    for (const k of keys) if (!(k in obj)) fail(`${key}.${k}`);
    return obj;
  };
  const text = (v: unknown, key: string): string => typeof v === 'string' && v.trim() ? v : fail(key);
  const num = (v: unknown, key: string, min: number, max = Infinity): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(key);
  const integer = (v: unknown, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const n = num(v, key, min, max); return Number.isSafeInteger(n) ? n : fail(key);
  };
  const strings = (v: unknown, key: string): string[] => Array.isArray(v) ? v.map((x, i) => text(x, `${key}[${i}]`)) : fail(key);
  const vec = (v: unknown, key: string): [number, number, number] => {
    if (!Array.isArray(v) || v.length !== 3) return fail(key);
    return [num(v[0], `${key}[0]`, -Infinity), num(v[1], `${key}[1]`, -Infinity), num(v[2], `${key}[2]`, -Infinity)];
  };
  const url = (v: unknown, key: string): string => {
    const s = text(v, key);
    try { const u = new URL(s); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail(key); } catch { fail(key); }
    return s.replace(/\/$/, '');
  };
  const root = object(input, 'config', ['llm','chat','commands','protect','home','selfGoal','reflex','reconnect','lease','server','bridge','paths']);
  const section = (name: string, keys: string[]) => object(root[name], name, keys);
  const l = section('llm', ['baseUrl','model','thinking']);
  const ch = section('chat', ['nicknames','wholeWords','minIntervalMs','maxLen','maxLinesPerReply']);
  const commands = section('commands', ['allowlist']);
  const p = section('protect', ['naturalBlocks','zones']);
  const s = section('selfGoal', ['radius']);
  const r = section('reflex', ['eatAtFood']);
  const re = section('reconnect', ['maxPerHour','backoffMs','stopPatterns']);
  const lease = section('lease', ['ttlMs','intervalMs']);
  const server = section('server', ['host','port']);
  const b = section('bridge', ['url','configPath']);
  const paths = section('paths', ['heuristicsDir','notesFile','transcriptDir']);
  const thinking = text(l.thinking, 'llm.thinking');
  if (thinking !== 'planning' && thinking !== 'off' && thinking !== 'on') return fail('llm.thinking');
  const allowlist = strings(commands.allowlist, 'commands.allowlist');
  allowlist.forEach((x, i) => { if (!/^\/[a-z0-9_]+$/.test(x)) fail(`commands.allowlist[${i}]`); });
  const naturalBlocks = strings(p.naturalBlocks, 'protect.naturalBlocks');
  naturalBlocks.forEach((x, i) => { if (!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(x)) fail(`protect.naturalBlocks[${i}]`); });
  if (!Array.isArray(p.zones)) return fail('protect.zones');
  const zones = p.zones.map((v, i) => {
    const key = `protect.zones[${i}]`, z = object(v, key, ['name','min','max']);
    const min = vec(z.min, `${key}.min`), max = vec(z.max, `${key}.max`);
    if (min.some((n, j) => n > max[j]!)) fail(key);
    return {name: text(z.name, `${key}.name`), min, max};
  });
  if (new Set(zones.map(z => z.name)).size !== zones.length) fail('protect.zones');
  if (!Array.isArray(re.backoffMs) || re.backoffMs.length === 0) return fail('reconnect.backoffMs');
  const backoffMs = re.backoffMs.map((n, i) => integer(n, `reconnect.backoffMs[${i}]`, 1));
  const ttlMs = integer(lease.ttlMs, 'lease.ttlMs', 1), intervalMs = integer(lease.intervalMs, 'lease.intervalMs', 1);
  if (intervalMs >= ttlMs) fail('lease.intervalMs');
  const bridgeUrl = url(b.url, 'bridge.url');
  if (new URL(bridgeUrl).hostname !== '127.0.0.1') fail('bridge.url');
  const relative = (v: unknown, key: string) => resolve(dirname(absolute), text(v, key));
  return {
    llm: {baseUrl: url(l.baseUrl, 'llm.baseUrl'), model: text(l.model, 'llm.model'), thinking},
    chat: {nicknames: strings(ch.nicknames, 'chat.nicknames'), wholeWords: strings(ch.wholeWords, 'chat.wholeWords'), minIntervalMs: integer(ch.minIntervalMs, 'chat.minIntervalMs', 3000), maxLen: integer(ch.maxLen, 'chat.maxLen', 1, 256), maxLinesPerReply: integer(ch.maxLinesPerReply, 'chat.maxLinesPerReply', 1, 2)},
    commands: {allowlist}, protect: {naturalBlocks, zones}, home: root.home === null ? null : vec(root.home, 'home'),
    selfGoal: {radius: num(s.radius, 'selfGoal.radius', 1)}, reflex: {eatAtFood: integer(r.eatAtFood, 'reflex.eatAtFood', 0, 20)},
    reconnect: {maxPerHour: integer(re.maxPerHour, 'reconnect.maxPerHour', 0, 3), backoffMs, stopPatterns: strings(re.stopPatterns, 'reconnect.stopPatterns')},
    lease: {ttlMs, intervalMs}, server: {host: text(server.host, 'server.host'), port: integer(server.port, 'server.port', 1, 65535)},
    bridge: {url: bridgeUrl, configPath: relative(b.configPath, 'bridge.configPath')},
    paths: {heuristicsDir: relative(paths.heuristicsDir, 'paths.heuristicsDir'), notesFile: relative(paths.notesFile, 'paths.notesFile'), transcriptDir: relative(paths.transcriptDir, 'paths.transcriptDir')},
  };
}

export function toConfigApply(c: Config): Record<string, unknown> {
  return {reflex: {enabled: true, eatAtFood: c.reflex.eatAtFood}, protect: c.protect,
    chat: {minIntervalMs: c.chat.minIntervalMs, maxLen: c.chat.maxLen},
    commandAllowlist: c.commands.allowlist, nicknames: {names: c.chat.nicknames, wholeWords: c.chat.wholeWords}};
}
