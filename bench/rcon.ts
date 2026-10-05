import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";

export function rconPacket(id: number, type: number, text: string): Buffer {
  if (text.includes("\0")) throw new Error("RCON text must not contain NUL");
  const body = Buffer.from(text, "utf8");
  if (body.length > 1446) throw new Error("RCON command is too long");
  const packet = Buffer.alloc(body.length + 14);
  packet.writeInt32LE(body.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  body.copy(packet, 12);
  return packet;
}

export function runRcon(command: string, password: string, port = 25575): Promise<string> {
  if (!command.trim()) return Promise.reject(new Error("RCON command is empty"));
  // Validate before opening the connection; never log the authentication packet.
  const auth = rconPacket(1, 3, password);
  const request = rconPacket(2, 2, command);
  const boundary = rconPacket(3, 2, "list");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = createConnection({ host: "127.0.0.1", port });
  let pending: Buffer = Buffer.alloc(0);
  const parts: Buffer[] = [];
  let authenticated = false;
  let boundarySent = false;
  let settled = false;
  const deadline = setTimeout(() => finish(new Error("RCON timed out after 10 seconds")), 10_000);
  function finish(error?: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    socket.destroy();
    if (error) reject(error);
    else resolve(Buffer.concat(parts).toString("utf8"));
  }
  socket.on("connect", () => socket.write(auth));
  socket.on("error", (error) => finish(error));
  socket.on("close", () => finish(new Error("RCON closed before a complete response")));
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (!settled && pending.length >= 4) {
      const length = pending.readInt32LE(0);
      // Allow a full 4096-character Minecraft reply chunk after UTF-8 encoding, plus ID/type/terminators.
      if (length < 10 || length > 16_394) return finish(new Error("Invalid RCON packet length"));
      if (pending.length < length + 4) return;
      const packet = pending.subarray(0, length + 4);
      pending = pending.subarray(length + 4);
      if (packet[length + 2] !== 0 || packet[length + 3] !== 0) {
        return finish(new Error("Invalid RCON packet terminator"));
      }
      const id = packet.readInt32LE(4);
      const type = packet.readInt32LE(8);
      if (id === -1) return finish(new Error("RCON authentication failed"));
      if (!authenticated) {
        if (id !== 1) return finish(new Error("Unexpected RCON authentication ID"));
        if (type === 0) continue; // Source may precede AUTH_RESPONSE with an empty RESPONSE_VALUE.
        if (type !== 2) return finish(new Error("Invalid RCON authentication response"));
        authenticated = true;
        socket.write(request);
      } else if (id === 2 && type === 0) {
        parts.push(packet.subarray(12, length + 2));
        if (!boundarySent) {
          // Send only after the first reply: Paper's legacy request reader must not receive coalesced requests.
          boundarySent = true;
          socket.write(boundary);
        }
      } else if (id === 3 && type === 0) {
        finish();
      } else {
        finish(new Error("Unexpected RCON response ID or type"));
      }
    }
  });
  return promise;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node bench/rcon.ts "<command>"');
    const password = (await readFile(new URL("./server/rcon.secret", import.meta.url), "utf8")).trim();
    if (!password) throw new Error("bench/server/rcon.secret is empty; start bench/server.ts first");
    console.log(await runRcon(process.argv[2]!, password));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
