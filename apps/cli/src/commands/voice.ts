import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SpeechWorkerClient,
  recordClip,
  hasCaptureDevice,
  playWav,
  runVoiceSetup,
  recommendWhisperModel,
  resolveSpeechWorkerDir,
  piperBinary,
  voicesDir,
} from "@doggie/voice";
import { readConfig, writeConfig } from "@doggie/shared";
import { transcribeClip } from "../lifecycle/transcribe.js";
import { doggieLine, errorLine, info, warn } from "../terminal/banner.js";

const SUPPORTED_LANG_CODES = ["auto", "en", "hi"];
const SUPPORTED_PROVIDERS = ["local", "gemini", "gemini-live"];

export async function runVoiceProviderCmd(name?: string): Promise<void> {
  if (!name) {
    const current = readConfig().sttProvider ?? "local";
    info(`Current STT provider: ${current}`);
    info("Usage: doggie voice provider <local|gemini|gemini-live>");
    return;
  }
  if (!SUPPORTED_PROVIDERS.includes(name)) {
    errorLine(`Unsupported provider '${name}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (name === "gemini") {
    warn(
      "Gemini is a cloud provider: your recorded speech will be sent to Google's servers " +
        "(not local anymore), and each request costs a small amount against your API key."
    );
  }
  if (name === "gemini-live") {
    warn(
      "Gemini Live streams your microphone continuously to Google's servers while active " +
        "(not brief clips like 'gemini') and is billed per-use — this is meaningfully more " +
        "expensive and less private than the default local pipeline. Only used in `--launch` " +
        "mode currently."
    );
  }
  if ((name === "gemini" || name === "gemini-live") && !process.env.GEMINI_API_KEY) {
    warn(
      "GEMINI_API_KEY is not set in your environment. Set it before using this provider: " +
        "export GEMINI_API_KEY=your-key-here (get one at https://aistudio.google.com/apikey). " +
        "The key is never written to Doggie's config file or logged."
    );
  }
  writeConfig({ sttProvider: name as "local" | "gemini" | "gemini-live" });
  doggieLine(`STT provider set to '${name}'.`);
  info("Takes effect on the next `doggie voice test` or the next `doggie` launch.");
}

export async function runVoiceLangCmd(code?: string): Promise<void> {
  if (!code) {
    const current = readConfig().sttLanguage ?? "auto";
    info(`Current forced STT language: ${current}`);
    info("Usage: doggie voice lang <auto|en|hi>");
    return;
  }
  if (!SUPPORTED_LANG_CODES.includes(code)) {
    errorLine(`Unsupported code '${code}'. Supported: ${SUPPORTED_LANG_CODES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  writeConfig({ sttLanguage: code });
  doggieLine(
    code === "auto"
      ? "STT language detection restored to automatic."
      : `STT language forced to '${code}' — auto-detection skipped from now on.`
  );
  info("Takes effect on the next `doggie voice test` or the next `doggie` launch.");
}

export async function runVoiceSetupCmd(): Promise<void> {
  let dir: string;
  try {
    dir = resolveSpeechWorkerDir();
  } catch (err) {
    errorLine((err as Error).message);
    process.exitCode = 1;
    return;
  }

  info(`Recommended Whisper model for this machine: ${recommendWhisperModel()} (based on free RAM)`);
  doggieLine("Setting up local voice stack (this downloads ~150MB of models on first run)...");
  try {
    const steps = await runVoiceSetup(dir);
    for (const s of steps) {
      console.log(`${s.ok ? "✅" : "❌"} ${s.label}: ${s.detail}`);
    }
    const failed = steps.filter((s) => !s.ok);
    if (failed.length === 0) doggieLine("Voice stack ready. Try `doggie voice test`.");
    else errorLine(`${failed.length} step(s) failed — see above.`);
  } catch (err) {
    errorLine(`Setup failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export async function runVoiceStatusCmd(): Promise<void> {
  let dir: string;
  try {
    dir = resolveSpeechWorkerDir();
  } catch (err) {
    errorLine((err as Error).message);
    info("Run `doggie voice setup` first.");
    return;
  }

  const venvOk = fs.existsSync(path.join(dir, ".venv", "bin", "python"));
  const piperOk = fs.existsSync(piperBinary(dir));
  const voices = fs.existsSync(voicesDir(dir))
    ? fs.readdirSync(voicesDir(dir)).filter((d) => !d.startsWith("."))
    : [];
  const micOk = await hasCaptureDevice();

  const config = readConfig();
  const forcedLang = config.sttLanguage ?? "auto";
  const provider = config.sttProvider ?? "local";
  info(`STT provider:    ${provider}${provider === "gemini" && !process.env.GEMINI_API_KEY ? " (GEMINI_API_KEY not set — will fall back to local)" : ""} (change with \`doggie voice provider <local|gemini>\`)`);
  info(`STT engine:      faster-whisper (${venvOk ? "installed" : "NOT installed"}), recommended model: ${recommendWhisperModel()}`);
  info(`STT language:    ${forcedLang} (change with \`doggie voice lang <auto|en|hi>\`)`);
  info(`TTS engine:      Piper (${piperOk ? "installed" : "NOT installed"})`);
  info(`Voices:          ${voices.length > 0 ? voices.join(", ") : "none downloaded"}`);
  info(`Microphone:      ${micOk ? "capture device detected (arecord -l)" : "no capture device detected"}`);
  info(
    "Kokoro TTS is not installed by default on this machine (disk headroom + unverified Hindi " +
      "quality — see ARCHITECTURE.md). Piper is the verified default for both English and Hindi."
  );
}

export async function runVoiceTestCmd(): Promise<void> {
  let dir: string;
  try {
    dir = resolveSpeechWorkerDir();
  } catch (err) {
    errorLine((err as Error).message);
    info("Run `doggie voice setup` first.");
    return;
  }
  if (!fs.existsSync(path.join(dir, ".venv", "bin", "python")) || !fs.existsSync(piperBinary(dir))) {
    errorLine("Voice stack isn't fully installed. Run `doggie voice setup` first.");
    return;
  }

  const micPresent = await hasCaptureDevice();
  if (!micPresent) {
    warn("No microphone capture device detected (arecord -l found nothing) — recording may fail or produce silence.");
  }

  const clipPath = path.join(os.tmpdir(), "doggie-voice-test.wav");
  const seconds = 4;
  doggieLine(`Recording ${seconds}s from the microphone — speak now...`);
  try {
    await recordClip(clipPath, seconds);
  } catch (err) {
    errorLine(`Recording failed: ${(err as Error).message}`);
    return;
  }
  doggieLine("Transcribing...");

  const worker = new SpeechWorkerClient(recommendWhisperModel());
  try {
    await worker.waitUntilReady();
    const result = await transcribeClip(clipPath, worker);
    console.log(`\n\u{1F3A4} YOU SAID:\n"${result.text || "(nothing recognized — silence or no mic input)"}"\n`);
    info(
      result.provider === "gemini"
        ? "provider: gemini (language/confidence not reported by this provider)"
        : `detected language: ${result.language} (confidence ${result.language_probability})`
    );

    const replyLang = result.language === "hi" ? "hi" : "en";
    const replyText =
      replyLang === "hi" ? "मैंने आपकी बात सुन ली।" : "I heard you loud and clear.";
    const outWav = path.join(os.tmpdir(), "doggie-voice-reply.wav");
    const speakResult = await worker.speak(replyText, replyLang, outWav);
    doggieLine(`Speaking reply: "${replyText}"`);
    try {
      await playWav(speakResult.wav_path);
    } catch (err) {
      warn(`Could not play audio (aplay failed: ${(err as Error).message}). The wav was still generated at ${speakResult.wav_path}.`);
    }
  } catch (err) {
    errorLine((err as Error).message);
  } finally {
    worker.stop();
  }
}
