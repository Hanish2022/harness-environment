import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import readline from "node:readline";
import { resolveOverlayBinary } from "./overlayBinary.js";

export class OverlayProcess {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private ready: Promise<void>;
  private exitFired = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const bin = resolveOverlayBinary();
    this.child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    // Same EPIPE-crashes-the-process hazard as packages/voice/src/playback.ts:
    // a write to this stdin after the overlay has already died emits an async
    // 'error' event, not a thrown exception, so it must be handled here too.
    this.child.stdin.on("error", () => {});

    this.ready = new Promise((resolve) => {
      const rl = readline.createInterface({ input: this.child.stdout });
      const onLine = (line: string) => {
        if (line.trim() === "DOGGIE_OVERLAY_READY") {
          rl.off("line", onLine);
          resolve();
        }
      };
      rl.on("line", onLine);
    });
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private isAlive(): boolean {
    if (!this.child.pid) return false;
    try {
      process.kill(this.child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `child.on("exit", ...)` alone was found live to not be reliable here:
   * `--launch` mode also runs node-pty (a native addon with its own
   * SIGCHLD/child-process handling) in the same process, and in a real
   * reproduction the overlay died (confirmed via `ps` showing it as a
   * zombie/<defunct>) while the exit event never fired — leaving the Node
   * process alive but unresponsive (even `doggie stop` timed out), a known
   * class of issue when mixing node-pty with plain child_process children.
   * This polls pid liveness directly as a backstop so a lost exit event
   * can't leave the parent silently stuck — whichever signal arrives first
   * (the real event or this poll) fires the callback exactly once.
   */
  onExit(cb: (code: number | null) => void): void {
    const fireOnce = (code: number | null) => {
      if (this.exitFired) return;
      this.exitFired = true;
      if (this.watchdog) clearInterval(this.watchdog);
      cb(code);
    };
    this.child.on("exit", (code) => fireOnce(code));
    this.watchdog = setInterval(() => {
      if (!this.exitFired && !this.isAlive()) fireOnce(this.child.exitCode);
    }, 4000);
  }

  hide(): void {
    this.child.stdin.write("hide\n");
  }

  show(): void {
    this.child.stdin.write("show\n");
  }

  setState(state: string): void {
    this.child.stdin.write(`state:${state}\n`);
  }

  setAmplitude(amplitude: number): void {
    this.child.stdin.write(`amp:${amplitude.toFixed(3)}\n`);
  }

  /** Asks the overlay to exit gracefully; falls back to SIGKILL after timeoutMs. */
  async quit(timeoutMs = 2000): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.write("quit\n");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
        resolve();
      }, timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
