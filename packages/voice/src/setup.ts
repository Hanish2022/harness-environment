import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

const PIPER_RELEASE =
  "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz";
const HF_VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

const DEFAULT_VOICES: Array<{ lang: "en" | "hi"; dir: string; file: string; hfPath: string }> = [
  {
    // Reverted from en_US-ryan-high after a real reported regression
    // (whispery/broken audio) — see worker.py's VOICE_MAP comment.
    lang: "en",
    dir: "en_US-norman-medium",
    file: "en_US-norman-medium.onnx",
    hfPath: "en/en_US/norman/medium/en_US-norman-medium.onnx",
  },
  {
    lang: "hi",
    dir: "hi_IN-pratham-medium",
    file: "hi_IN-pratham-medium.onnx",
    hfPath: "hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx",
  },
];

export interface SetupStep {
  label: string;
  ok: boolean;
  detail: string;
}

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  execFileSync(cmd, args, { stdio: "pipe", ...opts });
}

export function recommendWhisperModel(): string {
  const freeGB = os.freemem() / 1024 ** 3;
  // "small" is the practical floor for reliable Devanagari output on Hindi
  // speech — verified on this machine: "tiny"/"base" sometimes render Hindi
  // audio in Urdu/Perso-Arabic script instead, which is a real, surprising
  // failure mode worth avoiding by default. See ARCHITECTURE.md Phase 3.
  if (freeGB < 1.5) return "tiny"; // RAM-critical fallback; Hindi script fidelity not guaranteed
  return "small";
}

export async function runVoiceSetup(speechWorkerDir: string): Promise<SetupStep[]> {
  const steps: SetupStep[] = [];

  // 1. Python venv + faster-whisper
  const venvPython = path.join(speechWorkerDir, ".venv", "bin", "python");
  if (!fs.existsSync(venvPython)) {
    sh("python3", ["-m", "venv", ".venv"], { cwd: speechWorkerDir });
  }
  try {
    execFileSync(venvPython, ["-c", "import faster_whisper"], { stdio: "pipe" });
    steps.push({ label: "faster-whisper", ok: true, detail: "already installed" });
  } catch {
    sh(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
    sh(venvPython, ["-m", "pip", "install", "--quiet", "faster-whisper"]);
    // Pin av: the faster-whisper 1.2.x release is incompatible with
    // pip's latest PyAV (19.x) at the time this was built — its decode_audio
    // call uses a kwarg PyAV 19 removed. Verified by hitting the TypeError
    // and bisecting to av==13.1.0, which works. Revisit if upstream fixes it.
    sh(venvPython, ["-m", "pip", "install", "--quiet", "av==13.1.0"]);
    steps.push({ label: "faster-whisper", ok: true, detail: "installed (+ av==13.1.0 pin, see comment)" });
  }

  // 2. Piper binary
  const piperBin = path.join(speechWorkerDir, "bin", "piper", "piper");
  if (fs.existsSync(piperBin)) {
    steps.push({ label: "piper binary", ok: true, detail: "already installed" });
  } else {
    const tarPath = path.join(os.tmpdir(), "doggie-piper.tar.gz");
    sh("curl", ["-sL", PIPER_RELEASE, "-o", tarPath]);
    fs.mkdirSync(path.join(speechWorkerDir, "bin"), { recursive: true });
    sh("tar", ["-xzf", tarPath, "-C", path.join(speechWorkerDir, "bin")]);
    fs.rmSync(tarPath);
    steps.push({ label: "piper binary", ok: fs.existsSync(piperBin), detail: PIPER_RELEASE });
  }

  // 3. Default voices (English + Hindi)
  for (const v of DEFAULT_VOICES) {
    const dir = path.join(speechWorkerDir, "voices", v.dir);
    const onnxPath = path.join(dir, v.file);
    if (fs.existsSync(onnxPath)) {
      steps.push({ label: `voice: ${v.dir}`, ok: true, detail: "already downloaded" });
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    sh("curl", ["-sL", `${HF_VOICES_BASE}/${v.hfPath}`, "-o", onnxPath]);
    sh("curl", ["-sL", `${HF_VOICES_BASE}/${v.hfPath}.json`, "-o", `${onnxPath}.json`]);
    const sizeMB = fs.existsSync(onnxPath) ? (fs.statSync(onnxPath).size / 1024 ** 2).toFixed(0) : "0";
    steps.push({ label: `voice: ${v.dir}`, ok: fs.existsSync(onnxPath), detail: `${sizeMB}MB downloaded` });
  }

  return steps;
}
