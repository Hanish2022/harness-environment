import { spawn } from "node:child_process";

/**
 * Records `durationSec` of mono 16kHz PCM via `arecord` (ALSA) to `outPath`.
 * Push-to-talk style: the caller decides how long to record (no streaming
 * VAD-triggered start/stop yet — the bundled faster-whisper VAD filter trims
 * silence from the result, but doesn't drive capture start/stop itself).
 */
export function recordClip(outPath: string, durationSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("arecord", ["-f", "S16_LE", "-r", "16000", "-c", "1", "-d", String(durationSec), outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(new Error(`arecord not available: ${err.message}`)));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`arecord exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export interface MicStream {
  stop(): void;
}

/**
 * Continuously streams raw 16kHz/16-bit/mono PCM mic audio to `onChunk`
 * until `stop()` is called — no fixed duration. Used for Gemini Live, whose
 * own voice-activity detection decides when an utterance starts/ends, so
 * capture itself no longer needs to guess a recording window.
 */
export function streamMicrophone(onChunk: (pcm: Buffer) => void): MicStream {
  const proc = spawn("arecord", ["-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  proc.stdout.on("data", (chunk: Buffer) => onChunk(chunk));
  return {
    stop() {
      proc.kill("SIGTERM");
    },
  };
}

export function hasCaptureDevice(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("arecord", ["-l"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => resolve(out.includes("card")));
    proc.on("error", () => resolve(false));
  });
}
