// Downloads the pinned third-party mod jars the build and the client install need, verifying SHA256SUMS.
// Usage: node vendor/fetch.ts   (jars are not committed: MCPFabric MIT, Baritone LGPL-3.0, Fabric API Apache-2.0)
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const DIR = new URL("./", import.meta.url);
const SOURCES: Record<string, string> = {
  "mcpfabric-0.5.0+26.3.jar": "https://cdn.modrinth.com/data/eA63YgUh/versions/uPYTb8eq/mcpfabric-0.5.0%2B26.3.jar",
  "baritone-api-fabric-1.20.0.jar": "https://github.com/cabaletta/baritone/releases/download/v1.20.0/baritone-api-fabric-1.20.0.jar",
  "fabric-api-0.161.0+26.3.jar": "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.161.0+26.3/fabric-api-0.161.0+26.3.jar",
};

const sums = new Map<string, string>();
for (const line of (await readFile(new URL("SHA256SUMS", DIR), "utf8")).split("\n")) {
  const [hash, name] = line.trim().split(/\s+/);
  if (hash && name) sums.set(name, hash);
}

for (const [name, url] of Object.entries(SOURCES)) {
  const want = sums.get(name);
  if (!want) throw new Error(`${name} missing from SHA256SUMS`);
  const target = new URL(name, DIR);
  const existing = await readFile(target).catch(() => null);
  if (existing && createHash("sha256").update(existing).digest("hex") === want) {
    console.log(`ok      ${name}`);
    continue;
  }
  const response = await fetch(url, { headers: { "User-Agent": "qwencraft-vendor-fetch" } });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) throw new Error(`${name}: sha256 ${got} != ${want}; refusing to write`);
  await writeFile(target, bytes);
  console.log(`fetched ${name}`);
}
