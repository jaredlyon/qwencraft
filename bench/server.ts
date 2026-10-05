import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("./server/", import.meta.url));
const PAPER_SHA256 = "daf00db322543de77eb2012f37a1919537fafe13e04888ef256e56a5ca51af69";
// Pinned from https://fill.papermc.io/v3/projects/paper/versions/26.3/builds (build 151).
const PAPER_URL = `https://fill-data.papermc.io/v1/objects/${PAPER_SHA256}/paper-26.3-151.jar`;
const JAVA = "D:/qwencraft/.tools/jdk-25.0.4.1+1/bin/java.exe";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function startServer(): Promise<void> {
  await stat(JAVA); // Fail before downloading or changing configuration if the pinned JVM is missing.
  await mkdir(SERVER_DIR, { recursive: true });
  const jar = fileURLToPath(new URL("./server/paper.jar", import.meta.url));
  let exists = true;
  try {
    await stat(jar);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (!exists) {
    const temporary = `${jar}.part-${process.pid}`;
    console.log("Downloading Paper 26.3 build 151...");
    try {
      const response = await fetch(PAPER_URL, {
        headers: { "User-Agent": "qwencraft-phase1-bench (local Minecraft test harness)" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Paper download failed: HTTP ${response.status}`);
      await writeFile(temporary, new Uint8Array(await response.arrayBuffer()), { flag: "wx" });
      if (await sha256File(temporary) !== PAPER_SHA256) throw new Error("Paper download SHA-256 mismatch; refusing to run it");
      await rename(temporary, jar);
    } finally {
      await rm(temporary, { force: true });
    }
  } else if (await sha256File(jar) !== PAPER_SHA256) {
    throw new Error("bench/server/paper.jar SHA-256 mismatch; archive/remove it manually before downloading again");
  }

  const secret = fileURLToPath(new URL("./server/rcon.secret", import.meta.url));
  let password: string;
  try {
    password = (await readFile(secret, "utf8")).trim();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    password = randomBytes(32).toString("hex");
    await writeFile(secret, `${password}\n`, { flag: "wx", mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid bench/server/rcon.secret; refusing to replace the existing secret");
  await writeFile(new URL("./server/eula.txt", import.meta.url), "eula=true\n");
  await writeFile(new URL("./server/server.properties", import.meta.url), [
    "online-mode=false", "enforce-secure-profile=false", "server-ip=127.0.0.1", "server-port=25570",
    "enable-rcon=true", "rcon.port=25575", `rcon.password=${password}`, "spawn-protection=0",
    "difficulty=easy", "gamemode=survival", "level-seed=qwencraft", "",
  ].join("\n"), { mode: 0o600 });

  console.log("Paper checksum verified. Starting local bench at 127.0.0.1:25570 (RCON 25575).");
  const child = spawn(JAVA, ["-Xmx3G", "-jar", "paper.jar", "--nogui"], {
    cwd: SERVER_DIR, stdio: ["pipe", "inherit", "inherit"],
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let stopping = false;
  function stop(): void {
    if (stopping || !child.stdin.writable) return;
    stopping = true;
    console.log("Saving and stopping Paper...");
    child.stdin.write("stop\n");
  }
  // Pipe console input; Ctrl+C requests a normal save/stop rather than killing Java.
  process.stdin.pipe(child.stdin);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") reject(error);
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
    resolve();
  });
  try {
    await promise;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
  }
}

if (import.meta.main) {
  try {
    await startServer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
