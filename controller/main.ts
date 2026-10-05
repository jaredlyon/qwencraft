// Entry point: runs the controller (run.ts) and relaunches it when it exits for the console `restart` command,
// so code, config and heuristics reload from disk without the operator restarting this process.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { RESTART_EXIT_CODE } from './types.ts';

const run = fileURLToPath(new URL('./run.ts', import.meta.url));
// Ctrl+C reaches the child through the shared console; it shuts down cleanly and we exit with its code.
process.on('SIGINT', () => {});
for (;;) {
  const child = spawn(process.execPath, [run, ...process.argv.slice(2)], {stdio: 'inherit'});
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  if (code !== RESTART_EXIT_CODE) process.exit(code ?? (signal ? 1 : 0));
}
