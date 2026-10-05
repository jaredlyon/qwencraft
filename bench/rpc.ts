import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "../controller/config.ts";
import { createBridge } from "../controller/bridge.ts";
import { BridgeError } from "../controller/types.ts";

try {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 4) || (args.length === 4 && args[2] !== "--config")) {
    throw new Error("Usage: node bench/rpc.ts <method> '<json params>' [--config bench/qwencraft.bench.json]");
  }
  const method = args[0]!;
  if (!method.trim()) throw new Error("RPC method must not be empty");
  const params: unknown = JSON.parse(args[1]!);
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("RPC params must be a JSON object");
  }
  const path = args.length === 4 ? resolve(args[3]!) : fileURLToPath(new URL("./qwencraft.bench.json", import.meta.url));
  const config = loadConfig(path);
  // Unlike controller startup, a diagnostic CLI should fail promptly if the client has not created its token.
  await access(config.bridge.configPath);
  const bridge = await createBridge(config);
  const result = await bridge.rpc(method, params as Record<string, unknown>, { timeoutMs: 10_000 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = error instanceof BridgeError
    ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
    : { code: "bench_cli", message: error instanceof Error ? error.message : String(error) };
  console.error(JSON.stringify({ ok: false, error: failure }, null, 2));
  process.exitCode = 1;
}
