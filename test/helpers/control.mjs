import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";

// Mirrors control::address: SHA-256 of the canonical data path (Rust uses a verbatim path on Windows).
export function controlAddress(home, controlId) {
  const real = realpathSync.native(home);
  if (process.platform !== "win32") {
    const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 24);
    return path.join("/tmp", `cabletidy-${process.getuid()}-${hash}`, `${controlId}.sock`);
  }
  const verbatim = real.startsWith("\\\\") ? `\\\\?\\UNC\\${real.slice(2)}` : `\\\\?\\${real}`;
  const hash = crypto.createHash("sha256").update(verbatim).digest("hex").slice(0, 24);
  return `\\\\.\\pipe\\cabletidy-${hash}-${controlId}`;
}

// Completes a status exchange and keeps the connection open, which delays daemon exit after stop.
export async function holdControlConnection(home, runtime) {
  const socket = net.connect(controlAddress(home, runtime.controlId));
  let buffer = Buffer.alloc(0);
  const frames = [];
  let waiter;
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0);
      frames.push(JSON.parse(buffer.subarray(4, 4 + length)));
      buffer = buffer.subarray(4 + length);
    }
    waiter?.();
  });
  socket.on("error", () => {});
  const frame = () => new Promise((resolve, reject) => {
    const check = () => frames.length ? resolve(frames.shift()) : null;
    waiter = check;
    socket.once("close", () => reject(new Error("Control connection closed")));
    check();
  });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const hello = await frame();
  const request = Buffer.from(JSON.stringify({ version: hello.version, controlId: runtime.controlId, command: "status" }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(request.length);
  socket.write(Buffer.concat([header, request]));
  const reply = await frame();
  return { reply, close: () => socket.destroy() };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
