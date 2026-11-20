import { spawn, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline";
import type { Writable, Readable } from "node:stream";
import { resolveSpeechWorkerDir, speechWorkerPython } from "./paths.js";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export interface TranscribeResult {
  text: string;
  language: string;
  language_probability: number;
}

export interface SpeakResult {
  wav_path: string;
}

/**
 * Owns the Python speech worker subprocess for the lifetime of the Node
 * process that creates it (same ownership model as OverlayProcess). Not a
 * background daemon — it lives only as long as its parent `doggie` process.
 */
export class SpeechWorkerClient {
  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private ready: Promise<void>;

  constructor(whisperModel = "small") {
    const dir = resolveSpeechWorkerDir();
    const python = speechWorkerPython(dir);
    this.child = spawn(python, ["worker.py"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DOGGIE_WHISPER_MODEL: whisperModel },
    });
    // Same EPIPE-crashes-the-process hazard as packages/voice/src/playback.ts:
    // a write to this stdin after the worker has already died emits an async
    // 'error' event, not a thrown exception, so it must be handled here too.
    this.child.stdin.on("error", () => {});

    this.ready = new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input: this.child.stdout });
      const onLine = (line: string) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          rl.off("line", onLine);
          rl.on("line", (l) => this.handleLine(l));
          resolve();
        }
      };
      rl.on("line", onLine);
      this.child.once("error", reject);
      this.child.once("exit", (code) => {
        if (this.pending.size > 0) {
          for (const p of this.pending.values()) p.reject(new Error(`speech worker exited (code ${code})`));
        }
      });
    });
  }

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.error ?? "unknown speech worker error"));
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  private call<T>(cmd: string, body: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`speech worker timed out on ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ id, cmd, ...body }) + "\n");
    });
  }

  transcribe(audioPath: string, language?: string): Promise<TranscribeResult> {
    // 90s, not the default 30s: the first call on a fresh worker also pays
    // for the whisper model load, which was observed taking 30s+ on this
    // project's dev machine under real memory pressure (RAM often <1GB free,
    // swapping, competing with the GPU-rendered avatar for CPU) — see
    // ARCHITECTURE.md "Phase 3 resource contention". Subsequent calls on the
    // same worker are fast once the model is resident.
    return this.call("transcribe", { audio_path: audioPath, language }, 90000);
  }

  speak(text: string, lang: "en" | "hi", outPath: string): Promise<SpeakResult> {
    // 60s, not the default 30s: each call spawns a fresh Piper subprocess
    // (model load + synthesis both paid every time, nothing stays resident)
    // — measured ~7s in isolation for a long (341-char) reply, but hit the
    // default 30s timeout for real in live use, the same resource-contention
    // pattern as transcribe()'s 90s bump above (GPU-rendered avatar + wrapped
    // session competing for CPU/RAM on this project's dev machine).
    return this.call("speak", { text, lang, out_path: outPath }, 60000);
  }

  stop(): void {
    this.child.kill();
  }
}
