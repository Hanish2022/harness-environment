import net from "node:net";
import fs from "node:fs";
import { SOCKET_FILE } from "@doggie/shared";

/**
 * "hide" | "show" | "status" | "stop" are the user-facing commands (see CLI
 * section 7). `state:<AgentState>` and `amp:<0..1>` are internal plumbing
 * used by the orchestrator (Phase 5) to drive the avatar's animation state
 * and lip-sync amplitude — not exposed as their own `doggie` subcommands.
 */
export type ControlCommand = string;

export function startControlServer(
  handler: (cmd: ControlCommand) => Promise<string>
): net.Server {
  if (fs.existsSync(SOCKET_FILE)) {
    fs.rmSync(SOCKET_FILE);
  }

  const server = net.createServer((socket) => {
    socket.once("data", async (data) => {
      const cmd = data.toString().trim() as ControlCommand;
      try {
        const reply = await handler(cmd);
        socket.end(reply);
      } catch (err) {
        socket.end(`error: ${(err as Error).message}`);
      }
    });
  });

  server.listen(SOCKET_FILE);
  return server;
}

export function sendControlCommand(cmd: ControlCommand, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_FILE);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for Doggie to respond"));
    }, timeoutMs);

    let buf = "";
    socket.on("connect", () => socket.write(cmd));
    socket.on("data", (chunk) => (buf += chunk.toString()));
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(buf);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
