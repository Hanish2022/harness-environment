import { execFileSync } from "node:child_process";
import type { AgentSession } from "./types.js";

/** Process name fragments for the CLI agents named in the spec. Extend as more are added. */
const KNOWN_AGENT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\/)claude$/, label: "Claude Code" },
  { pattern: /kiro-cli-chat/, label: "Kiro CLI" },
  { pattern: /(^|\/)codex$/, label: "Codex CLI" },
];

interface PsRow {
  pid: string;
  tty: string;
  comm: string;
  args: string;
}

function listProcesses(): PsRow[] {
  const out = execFileSync("ps", ["-eo", "pid=,tty=,comm=,args="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      const [, pid, tty, comm, args] = match;
      return { pid, tty, comm, args };
    })
    .filter((r): r is PsRow => r !== null);
}

/**
 * Finds already-running candidate agent processes that have a real
 * controlling terminal (tty !== "?"), i.e. ones a plain-PTY adapter could
 * plausibly write input into. Processes with no tty (daemonized, or whose
 * terminal already exited) are excluded — there's nothing to attach to.
 */
export function detectPlainSessions(): AgentSession[] {
  const rows = listProcesses();
  const sessions: AgentSession[] = [];
  for (const row of rows) {
    if (row.tty === "?" || row.tty === "??") continue;
    const known = KNOWN_AGENT_PATTERNS.find((k) => k.pattern.test(row.comm) || k.pattern.test(row.args));
    if (!known) continue;
    sessions.push({
      id: row.pid,
      kind: "plain-pty",
      label: `${known.label} (pid ${row.pid}, /dev/${row.tty})`,
      capabilities: {
        canSendInstruction: true,
        canObserveOutput: false, // see ARCHITECTURE.md: a plain already-running terminal has no capturable scrollback
        canInterrupt: true,
      },
    });
  }
  return sessions;
}

export function processTty(pid: string): string | null {
  const rows = listProcesses();
  const row = rows.find((r) => r.pid === pid);
  if (!row || row.tty === "?" || row.tty === "??") return null;
  return `/dev/${row.tty}`;
}
