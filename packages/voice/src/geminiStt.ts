import fs from "node:fs";

/**
 * Optional cloud STT backend, opt-in only (spec: "cloud providers can be
 * added later, but they must never be mandatory" / "no mandatory cloud
 * APIs" / "never send microphone recordings to external services in the
 * default configuration" — this is never called unless the user explicitly
 * sets sttProvider to "gemini").
 *
 * Verified against Google's current docs before writing this (this
 * project's training data predates a real API evolution — Gemini has moved
 * well past the versions familiar from training, so nothing here was
 * guessed): endpoint is the long-standing `generateContent` REST method,
 * not the newer "Interactions API" also documented, since generateContent's
 * request/response shape could be cross-confirmed from multiple current
 * doc pages and the Interactions API's response shape could not be.
 *
 * Claude's API does not currently accept audio input at all — there is no
 * equivalent "Claude provider" to offer alongside this.
 */

// gemini-3.8-flash (Google's own docs example at the time this was written)
// consistently returned HTTP 503 "high demand" with a real API key during
// testing; gemini-3.5-flash-lite and gemini-2.5-flash both worked. Using
// the lite model as the default since it's the lighter/cheaper of the two
// confirmed-working options. Override via GEMINI_STT_MODEL if this shifts
// again — this API's model lineup is moving fast (gemini-2.5-flash-lite
// was already 404 "no longer available to new users" during this same test).
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiTranscribeResult {
  text: string;
}

export async function transcribeWithGemini(audioPath: string, apiKey: string): Promise<GeminiTranscribeResult> {
  const audioB64 = fs.readFileSync(audioPath).toString("base64");
  const model = process.env.GEMINI_STT_MODEL || DEFAULT_MODEL;

  const body = {
    contents: [
      {
        parts: [
          {
            text:
              "Transcribe this audio exactly as spoken. Output ONLY the verbatim transcription " +
              "text in the original spoken language and script. Do not translate it. Do not add " +
              "commentary, quotes, or any text besides the transcription itself. If there is no " +
              "speech, output nothing.",
          },
          { inlineData: { mimeType: "audio/wav", data: audioB64 } },
        ],
      },
    ],
  };

  const res = await fetch(`${ENDPOINT_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini API error (HTTP ${res.status}): ${errBody.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
  }
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Gemini response did not contain transcription text (unexpected response shape).");
  }
  return { text: text.trim() };
}
