import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SpeechWorkerClient, recordClip, playWav } from "@doggie/voice";
import { transcribeClip } from "./transcribe.js";
import { doggieLine, info } from "../terminal/banner.js";

const FOLLOWUP_RECORD_SECONDS = 4;
const MAX_ROUNDS = 3;

// Anchored to the WHOLE (trimmed) utterance, not "contains this word
// anywhere" — a real bug found live: "yes I want to say more, also check
// the other service" contains "more", so a substring match discarded the
// entire utterance (including the real new content) and just re-asked.
// Matching only short, exact phrases means a longer utterance — whatever
// words it happens to contain — always falls through to "append as new
// content" instead, which is what should happen.
const SEND_EXACT = /^(send|send it|yes|yeah|yep|yup|sure|go ahead|ship it|confirm)[.!]?$/i;
const DECLINE_EXACT = /^(no|nope|wait|hold on|not yet)[.!]?$/i;

// A well-documented Whisper failure mode: given a clip with little or no
// real speech (silence, background noise), it sometimes hallucinates a
// run of digits instead of returning empty — reported live as Doggie
// "reading 12345678 repeatedly" with no real output to speak at all. Treat
// a digits-only (or near-digits-only) transcription as if nothing was said,
// rather than appending hallucinated numbers as if they were real content.
const LOOKS_LIKE_DIGIT_HALLUCINATION = /^[\d\s,.\-]+$/;

/**
 * Fully voice-driven confirmation, replacing an earlier keyboard-based
 * "press Enter to send" step per explicit request: asks aloud whether to
 * send or keep talking, listens for a short spoken answer, and acts on it —
 * no key press required. If the answer is ambiguous after a couple of
 * rounds, defaults to NOT sending (safer than guessing) and says so.
 */
export async function confirmInstructionByVoice(
  worker: SpeechWorkerClient,
  initialText: string,
  replyLang: "en" | "hi"
): Promise<{ send: boolean; finalText: string }> {
  let combinedText = initialText;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const prompt =
      replyLang === "hi" ? "क्या मैं इसे भेज दूं, या आप और कुछ कहना चाहते हैं?" : "Should I send this, or do you want to say more?";
    doggieLine(`"${prompt}"`);
    try {
      const outWav = path.join(os.tmpdir(), `doggie-confirm-${Date.now()}.wav`);
      const speakResult = await worker.speak(prompt, replyLang, outWav);
      await playWav(speakResult.wav_path);
    } catch {
      // If speaking the prompt fails, still try listening — the text above was printed.
    }

    const clipPath = path.join(os.tmpdir(), `doggie-confirm-reply-${Date.now()}.wav`);
    await recordClip(clipPath, FOLLOWUP_RECORD_SECONDS);
    const result = await transcribeClip(clipPath, worker);
    fs.rm(clipPath, () => {});
    const heard = result.text.trim();
    info(`(confirmation) heard: "${heard || "(nothing)"}"`);

    if (heard && LOOKS_LIKE_DIGIT_HALLUCINATION.test(heard)) {
      info("(confirmation) ignoring likely silence-hallucination (digits-only transcription)");
      continue;
    }

    if (heard && SEND_EXACT.test(heard)) {
      return { send: true, finalText: combinedText };
    }
    if (heard && DECLINE_EXACT.test(heard)) {
      // A short, exact "no"/"wait" with nothing else said — loop and ask
      // again, giving them a clean chance to actually say the addition.
      continue;
    }
    if (heard) {
      // Anything longer or not an exact yes/no — whatever words it happens
      // to contain — is real additional content, not a confirmation. Append
      // it and ask again rather than discarding it or guessing it means "send".
      combinedText = `${combinedText} ${heard}`.trim();
      continue;
    }
    // Nothing recognized this round — ask again rather than assume either way.
  }

  doggieLine("Didn't get a clear answer — not sending. Press Ctrl+T to try again.");
  return { send: false, finalText: combinedText };
}
