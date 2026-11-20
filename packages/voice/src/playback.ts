import { spawn } from "node:child_process";

export function playWav(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("aplay", ["-q", path], { stdio: "ignore" });
    proc.on("error", (err) => reject(new Error(`aplay not available: ${err.message}`)));
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`aplay exited with code ${code}`))));
  });
}

export interface StreamingPlayer {
  write(pcm: Buffer): void;
  /** Immediate, hard stop — for barge-in: don't let already-queued audio keep playing. */
  stop(): void;
  /** Graceful stop: finish playing whatever's already been written, then resolve. */
  end(): Promise<void>;
}

/** Plays a continuous stream of raw PCM16 mono chunks as they arrive (Gemini Live's audio output, which comes in incrementally rather than as one complete file). */
export function createStreamingPlayer(sampleRate: number): StreamingPlayer {
  const proc = spawn("aplay", ["-q", "-f", "S16_LE", "-r", String(sampleRate), "-c", "1", "-t", "raw"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  let finished = false;
  proc.on("error", () => {
    finished = true;
  });
  // A write after aplay has already exited surfaces as an async 'error'
  // event on this stream (EPIPE), not a thrown exception — the try/catch
  // around write() below only catches synchronous throws, so without this
  // listener an EPIPE here was an uncaught exception that crashed the whole
  // process (reproduced live: a spoken reply arriving just as aplay closed).
  proc.stdin.on("error", () => {
    finished = true;
  });
  return {
    write(pcm) {
      if (finished || proc.killed || !proc.stdin.writable) return;
      try {
        proc.stdin.write(pcm);
      } catch {
        // aplay may have already exited (EPIPE) — nothing more to do.
      }
    },
    stop() {
      if (finished) return;
      finished = true;
      proc.kill("SIGKILL");
    },
    end() {
      return new Promise((resolve) => {
        if (finished) return resolve();
        finished = true;
        proc.once("exit", () => resolve());
        proc.stdin.end();
      });
    },
  };
}
