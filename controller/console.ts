import { createInterface, clearLine, cursorTo } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Vec3 } from './types.ts';

export interface ConsoleHandlers {
  instruction(text: string): void | Promise<void>;
  stop(): void | Promise<void>; resume(): void | Promise<void>; status(): void | Promise<void>;
  homeSet(): void | Promise<void>;
  zoneAdd(name: string, min: Vec3, max: Vec3): void | Promise<void>;
  zoneRemove(name: string): void | Promise<void>;
  say(text: string): void | Promise<void>; quit(): void | Promise<void>;
  error(message: string): void;
}

let active: Interface | null = null;

/** Prints a line above the input prompt, then redraws the prompt with whatever the operator has typed so far. */
export function print(message: string): void {
  if (!active || !process.stdout.isTTY) {console.log(message); return;}
  clearLine(process.stdout, 0); cursorTo(process.stdout, 0);
  process.stdout.write(`${message}\n`);
  active.prompt(true);
}

export function startConsole(handlers: ConsoleHandlers): () => void {
  const input = createInterface({input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY, prompt: 'qwencraft> '});
  active = input; input.prompt();
  input.on('line', line => {
    const text = line.trim(); input.prompt(); if (!text) return;
    void (async () => {
      switch (text) {
        case 'stop': await handlers.stop(); return;
        case 'resume': await handlers.resume(); return;
        case 'status': await handlers.status(); return;
        case 'home set': await handlers.homeSet(); return;
        case 'quit': await handlers.quit(); return;
      }
      if (text.startsWith('say ')) {await handlers.say(text.slice(4)); return;}
      const parts = text.split(/\s+/);
      if (parts[0] === 'zone') {
        if (parts[1] === 'rm' && parts.length === 3) {await handlers.zoneRemove(parts[2]!); return;}
        if (parts[1] === 'add' && parts.length === 9) {
          const values = parts.slice(3).map(Number);
          if (values.every(Number.isFinite)) {
            const min: Vec3 = [Math.min(values[0]!,values[3]!), Math.min(values[1]!,values[4]!), Math.min(values[2]!,values[5]!)];
            const max: Vec3 = [Math.max(values[0]!,values[3]!), Math.max(values[1]!,values[4]!), Math.max(values[2]!,values[5]!)];
            await handlers.zoneAdd(parts[2]!, min, max); return;
          }
        }
        throw new Error('Usage: zone add <name> x1 y1 z1 x2 y2 z2 | zone rm <name>');
      }
      if (['stop','resume','status','home','say','quit'].includes(parts[0]!)) throw new Error(`Invalid reserved command: ${parts[0]}`);
      await handlers.instruction(text);
    })().catch(error => handlers.error(error instanceof Error ? error.message : 'Console command failed'));
  });
  input.on('close', () => {void Promise.resolve(handlers.quit()).catch(error => handlers.error(error instanceof Error ? error.message : 'Shutdown failed'));});
  return () => {active = null; input.removeAllListeners('close'); input.close();};
}
