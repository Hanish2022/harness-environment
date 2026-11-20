import fs from "node:fs";
import { CONFIG_FILE, DOGGIE_HOME } from "./paths.js";

export interface DoggieConfig {
  /**
   * Forces faster-whisper's language instead of relying on auto-detection.
   * Added after real testing showed auto-detect confidently (but wrongly)
   * misclassifying clear English/Hindi speech as Hindi/Arabic on a real
   * microphone, even though the words were transcribed phonetically
   * correctly — see TASKS.md Phase 3 for the full story. "auto" (default)
   * restores detection.
   */
  sttLanguage?: string;
  /**
   * "local" (default) uses faster-whisper, fully offline. "gemini" sends
   * a recorded clip to Google's one-shot Gemini transcription API instead.
   * "gemini-live" replaces the whole per-utterance STT+TTS cycle with a
   * single continuous Gemini Live session (real-time audio-to-audio, the
   * API's own voice-activity detection instead of a fixed recording
   * window) — only used in `--launch` single-terminal mode currently.
   * All non-"local" options are opt-in, never the default, per the spec's
   * zero-cost/no-mandatory-cloud constraint, and genuinely cost money per
   * use (Gemini Live especially — it streams continuously while active,
   * not just brief clips). The API key itself is never stored here: read
   * from the GEMINI_API_KEY environment variable at call time only, so
   * it's never written to disk or logged.
   */
  sttProvider?: "local" | "gemini" | "gemini-live";
}

export function readConfig(): DoggieConfig {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(patch: Partial<DoggieConfig>): DoggieConfig {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(DOGGIE_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}
