import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { detectPlainSessions, processTty } from "./detect.js";
import type { AgentAdapter, AgentSession, AgentStatus } from "./types.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commOf(pid: string): string | null {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Attaches to an already-running CLI agent in a plain (non-tmux) terminal by
 * writing directly to its controlling PTY's slave device node — the same
 * generic Linux mechanism tools like `expect` use, not a tmux-specific
 * feature. Validated against a disposable `cat` process reading from a
 * freshly-created pty with echo explicitly disabled (to rule out mistaking
 * terminal echo for real delivery) before being used here — see
 * ARCHITECTURE.md "Phase 4: plain-terminal attachment".
 *
 * Deliberate, honest limitations (do not paper over these):
 *  - No output capture. A plain terminal keeps no scrollback buffer another
 *    process can read; only tmux (or wrapping the process from launch, see
 *    the Phase 4 "wrapped" adapter) can observe output. `observeOutput` is a
 *    documented no-op here, not a hidden failure.
 *  - Best-effort input only. Programs that put their PTY in raw mode for
 *    rich line-editing (likely true of Claude Code/Kiro/Codex) read raw
 *    bytes themselves rather than relying on the kernel's line buffering;
 *    a plain `text + "\n"` write should submit a line for most such tools,
 *    but perfect fidelity with real keystrokes (bracketed paste, escape
 *    sequences) isn't guaranteed.
 *  - getStatus() always returns "WAITING_FOR_INPUT" with a null detail,
 *    because this adapter genuinely has no way to know what the agent is
 *    doing — never fabricated progress.
 */
export class PlainPtyAdapter implements AgentAdapter {
  private pid: string | null = null;
  private ttyPath: string | null = null;

  async detectSessions(): Promise<AgentSession[]> {
    return detectPlainSessions();
  }

  async attach(sessionId: string): Promise<void> {
    const ttyPath = processTty(sessionId);
    if (!ttyPath) {
      throw new Error(`pid ${sessionId} has no controlling terminal (already exited, or not a real tty).`);
    }
    try {
      fs.accessSync(ttyPath, fs.constants.W_OK);
    } catch {
      throw new Error(`No write permission on ${ttyPath} (owned by a different user?).`);
    }
    this.pid = sessionId;
    this.ttyPath = ttyPath;
  }

  private assertAttached(): { pid: string; ttyPath: string } {
    if (!this.pid || !this.ttyPath) {
      throw new Error("Not attached to a session. Call attach() first.");
    }
    if (!isProcessAlive(Number(this.pid))) {
      throw new Error(`Attached process (pid ${this.pid}) is no longer running.`);
    }
    // Re-verify the tty still maps to the same pid before every write —
    // guards against PID reuse between attach() and this call.
    const stillTty = processTty(this.pid);
    if (stillTty !== this.ttyPath) {
      throw new Error(`pid ${this.pid}'s controlling terminal changed unexpectedly; refusing to write.`);
    }
    return { pid: this.pid, ttyPath: this.ttyPath };
  }

  async sendInstruction(text: string): Promise<void> {
    const { ttyPath } = this.assertAttached();
    const fd = fs.openSync(ttyPath, "w");
    try {
      fs.writeSync(fd, text.endsWith("\n") ? text : text + "\n");
    } finally {
      fs.closeSync(fd);
    }
  }

  observeOutput(onData: (chunk: string) => void): void {
    void onData;
    // Intentionally a no-op — see class docstring. Logged once by the caller
    // (apps/cli), not here, to avoid duplicate warnings across calls.
  }

  async interrupt(): Promise<void> {
    const { ttyPath } = this.assertAttached();
    const fd = fs.openSync(ttyPath, "w");
    try {
      fs.writeSync(fd, "\x03"); // Ctrl-C: the tty driver turns this into SIGINT for the foreground process group.
    } finally {
      fs.closeSync(fd);
    }
  }

  async getStatus(): Promise<AgentStatus> {
    if (!this.pid) return { state: "IDLE", detail: null };
    const alive = isProcessAlive(Number(this.pid));
    if (!alive) return { state: "ERROR", detail: `pid ${this.pid} is no longer running` };
    const name = commOf(this.pid);
    return {
      state: "WAITING_FOR_INPUT",
      detail: `attached to pid ${this.pid}${name ? ` (${name})` : ""} — output cannot be observed on a plain terminal`,
    };
  }

  async detach(): Promise<void> {
    this.pid = null;
    this.ttyPath = null;
  }
}
