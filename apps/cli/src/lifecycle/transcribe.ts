import { readConfig } from "@doggie/shared";
import { SpeechWorkerClient, transcribeWithGemini } from "@doggie/voice";
import { warn } from "../terminal/banner.js";

export interface TranscribeOutcome {
  text: string;
  language: string;
  language_probability: number | null;
  provider: "local" | "gemini";
}

/**
 * Single place both the live voice loop and `doggie voice test` go through,
 * so the local/Gemini branch only has to be gotten right once. Falls back
 * to local (loudly, not silently) if Gemini is selected but no API key is
 * present — never silently sends audio to the cloud, and never silently
 * fails a configured choice without telling the user why.
 */
export async function transcribeClip(clipPath: string, worker: SpeechWorkerClient): Promise<TranscribeOutcome> {
  const config = readConfig();
  const forcedLang = config.sttLanguage === "auto" ? undefined : config.sttLanguage;

  if (config.sttProvider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      warn("STT provider is set to 'gemini' but GEMINI_API_KEY isn't set — falling back to local Whisper for this turn.");
    } else {
      const result = await transcribeWithGemini(clipPath, apiKey);
      return { text: result.text, language: "unknown", language_probability: null, provider: "gemini" };
    }
  }

  const result = await worker.transcribe(clipPath, forcedLang);
  return {
    text: result.text,
    language: result.language,
    language_probability: result.language_probability,
    provider: "local",
  };
}
