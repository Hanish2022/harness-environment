import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Mirrors apps/cli's overlayBinary.ts: dev-monorepo layout first, env override for packaging. */
export function resolveSpeechWorkerDir(): string {
  if (process.env.DOGGIE_SPEECH_WORKER_DIR) {
    return process.env.DOGGIE_SPEECH_WORKER_DIR;
  }
  const candidates = [
    path.resolve(__dirname, "../../../services/speech-worker"),
    path.resolve(__dirname, "../../services/speech-worker"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "worker.py"))) {
      return candidate;
    }
  }
  throw new Error(
    "services/speech-worker not found. Run `doggie voice setup` first, or set DOGGIE_SPEECH_WORKER_DIR."
  );
}

export function speechWorkerPython(dir: string): string {
  const venvPython = path.join(dir, ".venv", "bin", "python");
  if (fs.existsSync(venvPython)) return venvPython;
  throw new Error(
    `No Python venv at ${venvPython}. Run \`doggie voice setup\` to install faster-whisper first.`
  );
}

export function piperBinary(dir: string): string {
  return path.join(dir, "bin", "piper", "piper");
}

export function voicesDir(dir: string): string {
  return path.join(dir, "voices");
}
