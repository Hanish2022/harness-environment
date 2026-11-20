import fs from "node:fs";
import { PID_FILE, STATE_FILE, RUN_DIR, SOCKET_FILE } from "@doggie/shared";
import type { DoggieRunState } from "@doggie/shared";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns the running instance's pid, or null and cleans up stale run files. */
export function checkRunningInstance(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  if (Number.isFinite(pid) && isProcessAlive(pid)) {
    return pid;
  }
  // stale files from a previous crash
  for (const f of [PID_FILE, SOCKET_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  return null;
}

export function writeRunFiles(pid: number): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

export function cleanupRunFiles(): void {
  for (const f of [PID_FILE, SOCKET_FILE, STATE_FILE]) {
    if (fs.existsSync(f)) {
      try {
        fs.rmSync(f);
      } catch {
        // best effort
      }
    }
  }
}

export function writeState(state: DoggieRunState): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function readState(): DoggieRunState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
