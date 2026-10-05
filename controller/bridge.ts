import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './types.ts';
import type { Bridge, Config, RpcOptions } from './types.ts';

export async function createBridge(c: Config): Promise<Bridge> {
  let token = '';
  // The dev client creates this file on first launch; waiting must not require a pre-existing token.
  while (!token) {
    try {
      const data: unknown = JSON.parse(await readFile(c.bridge.configPath, 'utf8'));
      if (!data || typeof data !== 'object' || !('token' in data) || typeof data.token !== 'string' || !data.token.trim()) throw new Error('Bridge config token is missing');
      const settings = data as Record<string, unknown>;
      const required: Record<string, unknown> = {host: '127.0.0.1', requireAuth: true, enableWorldWrite: false, enableCommands: false, enablePlayerControl: true, enableVision: true};
      for (const [key, value] of Object.entries(required)) if (settings[key] !== value) throw new Error(`Unsafe MCPFabric config key: ${key}`);
      token = data.token;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      await delay(1000);
    }
  }
  const bridge: Bridge = {
    async health() {
      try { return (await fetch(`${c.bridge.url}/health`, {signal: AbortSignal.timeout(3000)})).ok; }
      catch { return false; }
    },
    async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: RpcOptions = {}): Promise<T> {
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 10000)]) : AbortSignal.timeout(opts.timeoutMs ?? 10000);
      try {
        const response = await fetch(`${c.bridge.url}/rpc`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify({method, params}), signal});
        if (!response.ok) throw new BridgeError('transport', `Bridge HTTP ${response.status}`);
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('ok' in body)) throw new BridgeError('transport', 'Invalid bridge envelope');
        if (body.ok === true && 'result' in body) return body.result as T;
        if (body.ok === false && 'error' in body && body.error && typeof body.error === 'object' && 'code' in body.error && 'message' in body.error && typeof body.error.code === 'string' && typeof body.error.message === 'string') {
          throw new BridgeError(body.error.code, body.error.message, 'data' in body.error ? body.error.data : undefined);
        }
        throw new BridgeError('transport', 'Invalid bridge envelope');
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('transport', signal.aborted ? 'Bridge call aborted or timed out; outcome unknown' : 'Bridge transport failed; outcome unknown');
      }
    },
  };
  return bridge;
}
