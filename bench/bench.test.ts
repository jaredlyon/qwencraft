import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../controller/config.ts";
import { rconPacket, runRcon } from "./rcon.ts";
import { sha256File } from "./server.ts";

test("RCON wire encoding and file SHA-256 have independent known values", async (t) => {
  assert.equal(rconPacket(1, 3, "pw").toString("hex"), "0c000000010000000300000070770000");
  assert.throws(() => rconPacket(1, 2, "bad\0command"), /NUL/);
  const dir = await mkdtemp(join(tmpdir(), "qwencraft-bench-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "bytes");
  await writeFile(file, "abc");
  assert.equal(await sha256File(file), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("bench config uses isolated ports and config-relative paths", () => {
  const config = loadConfig(fileURLToPath(new URL("./qwencraft.bench.json", import.meta.url)));
  assert.deepEqual(config.server, { host: "127.0.0.1", port: 25570 });
  assert.equal(config.bridge.url, "http://127.0.0.1:25599");
  assert.equal(config.bridge.configPath, fileURLToPath(new URL("../mod/run/config/mcpfabric.config.json", import.meta.url)));
  assert.equal(config.paths.heuristicsDir, fileURLToPath(new URL("../heuristics", import.meta.url)));
  assert.equal(config.paths.notesFile, fileURLToPath(new URL("./server/bench-notes.json", import.meta.url)));
  assert.equal(config.paths.transcriptDir, fileURLToPath(new URL("./logs", import.meta.url)));
  assert.equal(config.home, null);
  assert.deepEqual(config.chat.nicknames, ["QwenBench"]);
  assert.deepEqual(config.chat.wholeWords, ["jared"]);
  assert.deepEqual(config.commands.allowlist, ["/spawn", "/home", "/sethome", "/msg", "/r", "/tell"]);
});

for (const rejectAuth of [false, true]) {
  test(`RCON ${rejectAuth ? "rejects bad credentials" : "authenticates and collects fragmented multi-packet UTF-8"}`, async (t) => {
    const sockets = new Set<Socket>();
    const received: string[] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let pending: Buffer = Buffer.alloc(0);
      const { promise: responseWritten, resolve: responseDone } = Promise.withResolvers<void>();
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4) {
          const length = pending.readInt32LE(0);
          if (pending.length < length + 4) return;
          const packet = pending.subarray(0, length + 4);
          pending = pending.subarray(length + 4);
          const id = packet.readInt32LE(4);
          const text = packet.subarray(12, length + 2).toString("utf8");
          received.push(text);
          if (id === 1) {
            socket.write(Buffer.concat([rconPacket(1, 0, ""), rconPacket(rejectAuth ? -1 : 1, 2, "")]));
          } else if (id === 2) {
            const bytes = Buffer.from("first 🌲 second", "utf8");
            // Split inside the emoji as well as across TCP chunks to expose per-packet UTF-8 decoding bugs.
            const first = rconPacket(2, 0, "first ");
            const second = rconPacket(2, 0, "🌲 second");
            const split = Buffer.alloc(12 + 1 + 2);
            split.writeInt32LE(11, 0);
            split.writeInt32LE(2, 4);
            bytes.copy(split, 12, 6, 7);
            const rest = Buffer.alloc(12 + bytes.length - 7 + 2);
            rest.writeInt32LE(rest.length - 4, 0);
            rest.writeInt32LE(2, 4);
            bytes.copy(rest, 12, 7);
            const response = Buffer.concat([first, split, rest]);
            // `second` independently establishes the expected UTF-8 byte sequence, not packet boundaries.
            assert.deepEqual(Buffer.concat([split.subarray(12, 13), rest.subarray(12, -2)]), second.subarray(12, -2));
            socket.write(response.subarray(0, 3));
            setImmediate(() => {
              socket.write(response.subarray(3, 9));
              setImmediate(() => socket.write(response.subarray(9), () => responseDone()));
            });
          } else if (id === 3) {
            void responseWritten.then(() => socket.write(rconPacket(3, 0, "There are 0 players")));
          }
        }
      });
    });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      const closed = once(server, "close");
      server.close();
      await closed;
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    if (rejectAuth) {
      await assert.rejects(runRcon("op QwenBench", "pw", address.port), /authentication failed/);
      assert.deepEqual(received, ["pw"]);
    } else {
      assert.equal(await runRcon("op QwenBench", "pw", address.port), "first 🌲 second");
      assert.deepEqual(received, ["pw", "op QwenBench", "list"]);
    }
  });
}
