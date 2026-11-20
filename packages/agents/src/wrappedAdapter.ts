import * as pty from "node-pty";
import pkg from "@xterm/headless";
import type { Terminal as TerminalType } from "@xterm/headless";
const { Terminal } = pkg;
import type { AgentAdapter, AgentSession, AgentStatus } from "./types.js";

/**
 * Fallback mode #5 from the spec's integration-strategy priority list:
 * Doggie launches the agent itself, inside a real pseudo-terminal it owns
 * (via node-pty, which built and linked successfully on this machine without
 * needing new system packages). This gives genuine full-duplex control —
 * real sendInstruction *and* real observeOutput — unlike the plain-PTY
 * adapter, at the cost of being a *new* session rather than an existing one.
 *
 * Output is captured through a real headless terminal emulator
 * (@xterm/headless), not a regex pass over raw bytes. That replaced an
 * earlier regex-based approach (strip ANSI, collapse bare \r as "overwrite")
 * after real testing against an actual rich CLI (Kiro, which does
 * cursor-addressed full-screen redraws, not just simple line output or
 * basic \r spinners) kept producing wrong or empty captures no amount of
 * regex patching fixed — that kind of redraw needs a real terminal screen
 * buffer that tracks cursor position and cell state, which is what a
 * terminal emulator library is for. Reading `buffer.active` gives the
 * correctly reconstructed, currently-displayed text regardless of how the
 * child redrew it.
 */
const SCROLLBACK_LINES = 2000;
// How much of the buffer counts as "recent" for getRecentOutput() — NOT the
// same as SCROLLBACK_LINES above. Found live: returning the whole 2000-line
// scrollback meant that in any long-running (e.g. --resume-id) session,
// "recent" output was actually the session's *first* lines — a stale
// startup banner and ASCII art from hours earlier — since the buffer was
// joined from line 0 onward with no window at all. This caps it to what's
// actually recent: the current viewport plus a little scrolled-past cushion.
const RECENT_OUTPUT_LINES = 200;

export class WrappedProcessAdapter implements AgentAdapter {
  private proc: pty.IPty | null = null;
  private term: TerminalType | null = null;
  private lastOutputAt = 0;
  private dataListeners: Array<(chunk: string) => void> = [];
  private cwd: string | null = null;

  async detectSessions(): Promise<AgentSession[]> {
    // Nothing to "detect" — this mode creates a session, it doesn't find one.
    return [];
  }

  /** sessionId here is the shell command to launch, e.g. "claude". */
  async attach(sessionId: string, size?: { cols: number; rows: number }): Promise<void> {
    if (this.proc) throw new Error("Already attached to a wrapped process. Call detach() first.");
    const cols = size?.cols ?? 120;
    const rows = size?.rows ?? 40;
    const [cmd, ...args] = sessionId.split(" ");

    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.cwd = process.cwd();

    this.proc = pty.spawn(cmd, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env: process.env as Record<string, string>,
    });
    this.proc.onData((chunk) => {
      this.lastOutputAt = Date.now();
      this.term?.write(chunk);
      for (const listener of this.dataListeners) listener(chunk);
    });
  }

  /**
   * The full current terminal screen + scrollback, as it would actually be
   * displayed — trailing blank lines trimmed. This is NOT a semantic
   * summary — there's no LLM reading this and explaining what happened, by
   * design (spec section 10's deterministic-orchestrator requirement). It's
   * the real recent output, rendered correctly, shown as-is.
   */
  getRecentOutput(): string {
    if (!this.term) return "";
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    // Trim trailing blank lines (a mostly-empty viewport below short output).
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-RECENT_OUTPUT_LINES).join("\n").trim();
  }

  /** The directory the wrapped process was actually launched in — ground
   * truth from the filesystem, not something scraped off the terminal
   * screen (which only shows whatever the wrapped program happens to have
   * printed, not necessarily its real cwd). */
  getWorkingDirectory(): string | null {
    return this.cwd;
  }

  /**
   * Milliseconds since the pty last emitted *any* bytes, including pure
   * escape-sequence redraws (a spinner updating in place, for instance).
   * This is intentionally about raw byte arrival, not rendered-text change —
   * see waitForResponse() in apps/cli for why that distinction matters.
   */
  getIdleMs(): number {
    if (this.lastOutputAt === 0) return 0;
    return Date.now() - this.lastOutputAt;
  }

  private assertAttached(): pty.IPty {
    if (!this.proc) throw new Error("Not attached. Call attach() first.");
    return this.proc;
  }

  async sendInstruction(text: string): Promise<void> {
    const proc = this.assertAttached();
    proc.write(text.endsWith("\r") || text.endsWith("\n") ? text : text + "\r");
  }

  /** Raw passthrough for interactive keystrokes — single-terminal mode (see launchMode.ts). */
  writeRaw(data: string): void {
    this.assertAttached().write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.proc) this.proc.resize(cols, rows);
    if (this.term) this.term.resize(cols, rows);
  }

  observeOutput(onData: (chunk: string) => void): void {
    this.dataListeners.push(onData);
  }

  async interrupt(): Promise<void> {
    const proc = this.assertAttached();
    proc.write("\x03");
  }

  async getStatus(): Promise<AgentStatus> {
    if (!this.proc) return { state: "IDLE", detail: null };
    const idleMs = this.getIdleMs();
    // Heuristic, not a real lifecycle hook: no raw byte activity for >2s
    // after some activity suggests it's waiting on you, not actively
    // working. Genuine tool-run/approval states need the agent's own
    // structured hooks (Phase 5+), which none of Claude Code/Kiro/Codex
    // exposed in a way this project could integrate against in this session.
    const state = this.lastOutputAt === 0 ? "EXECUTING" : idleMs > 2000 ? "WAITING_FOR_INPUT" : "EXECUTING";
    return { state, detail: `wrapped pty, ${Math.round(idleMs / 1000)}s since last output` };
  }

  async detach(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
    this.term?.dispose();
    this.term = null;
    this.dataListeners = [];
    this.cwd = null;
  }
}
