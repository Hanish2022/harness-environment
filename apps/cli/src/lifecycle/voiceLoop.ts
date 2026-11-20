import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  SpeechWorkerClient,
  recordClip,
  resolveSpeechWorkerDir,
  piperBinary,
  recommendWhisperModel,
} from "@doggie/voice";
import type { AgentState } from "@doggie/shared";
import type { AgentAdapter } from "@doggie/agents";
import { classifyIntent } from "@doggie/orchestrator";
import { playWav } from "@doggie/voice";
import { transcribeClip } from "./transcribe.js";
import { confirmInstructionByVoice } from "./voiceConfirm.js";
import { doggieLine, info, warn, errorLine } from "../terminal/banner.js";

const RECORD_SECONDS = 6;

export interface VoiceLoopHandle {
  stop(): void;
}

/**
 * Terminal push-to-talk per spec section 9/13: press Enter in Doggie's
 * terminal to record, transcribe, and print the exact transcription here.
 * This is a simplification of "push-to-talk" (fixed-length recording per
 * press, not press-and-hold with a variable stop point) and of the global
 * "Ctrl+Space" shortcut (that needs OS-level hotkey registration — Phase 6,
 * see TASKS.md). Forwarding the instruction to an attached coding agent is
 * Phase 4/5 — this prints what it *would* send, honestly, rather than
 * pretending to forward it anywhere yet.
 */
export function startVoiceLoop(
  onStateChange: (s: AgentState) => void,
  getAttachedAgent: () => { adapter: AgentAdapter; label: string } | null
): VoiceLoopHandle {
  let dir: string;
  try {
    dir = resolveSpeechWorkerDir();
  } catch {
    info("Voice input not set up yet — run `doggie voice setup` in another terminal, then restart Doggie.");
    return { stop() {} };
  }
  if (!fs.existsSync(path.join(dir, ".venv", "bin", "python")) || !fs.existsSync(piperBinary(dir))) {
    info("Voice input not set up yet — run `doggie voice setup` in another terminal, then restart Doggie.");
    return { stop() {} };
  }

  const worker = new SpeechWorkerClient(recommendWhisperModel());
  let busy = false;
  let closed = false;

  const rl = readline.createInterface({ input: process.stdin });
  info(`Voice ready: press Enter here then speak (records ${RECORD_SECONDS}s). Ctrl+C to quit.`);

  rl.on("line", async () => {
    if (busy || closed) return;
    busy = true;
    try {
      onStateChange("LISTENING");
      doggieLine("Listening...");
      const clipPath = path.join(os.tmpdir(), `doggie-turn-${Date.now()}.wav`);
      await recordClip(clipPath, RECORD_SECONDS);

      onStateChange("TRANSCRIBING");
      await worker.waitUntilReady();
      const result = await transcribeClip(clipPath, worker);
      fs.rm(clipPath, () => {});

      const text = result.text || "(nothing recognized)";
      console.log(`\n\u{1F3A4} YOU SAID:\n"${text}"\n`);
      info(
        result.provider === "gemini"
          ? "provider: gemini"
          : `language: ${result.language} (confidence ${result.language_probability})`
      );

      if (result.text) {
        const intent = classifyIntent(result.text);
        info(`intent: ${intent.type} (matched: ${intent.matchedRule})`);
        const attached = getAttachedAgent();
        const replyLang = result.language === "hi" ? "hi" : "en";
        let spoken: string | null = null;

        switch (intent.type) {
          case "AGENT_CONTROL":
            if (attached) {
              onStateChange("INTERRUPTED");
              await attached.adapter.interrupt();
              doggieLine(`Sent interrupt (Ctrl-C) to ${attached.label}.`);
              spoken = replyLang === "hi" ? "रोक रहा हूं।" : "Stopping.";
            } else {
              info("No agent attached — nothing to interrupt.");
              spoken = replyLang === "hi" ? "कोई एजेंट जुड़ा नहीं है।" : "No agent is attached.";
            }
            break;
          case "QUESTION": {
            if (attached) {
              const status = await attached.adapter.getStatus();
              info(`agent status: ${status.state}${status.detail ? ` — ${status.detail}` : ""}`);
              // No LLM reads the session's actual content, by design (spec
              // section 10) — never speak the raw technical `detail` string
              // as if it were an answer to what was asked.
              spoken =
                replyLang === "hi"
                  ? "मैं इस सत्र का आउटपुट नहीं देख सकता, इसलिए आपके सवाल का जवाब नहीं दे सकता।"
                  : "I can't read this session's output, so I can't actually answer that — I can only tell you whether it looks idle or busy.";
            } else {
              info("No agent attached to ask about.");
              spoken = replyLang === "hi" ? "कोई एजेंट जुड़ा नहीं है।" : "No agent is attached yet.";
            }
            break;
          }
          case "INSTRUCTION":
            if (attached) {
              const confirmation = await confirmInstructionByVoice(worker, result.text, replyLang);
              if (!confirmation.send) break;
              onStateChange("SENDING_INSTRUCTION");
              doggieLine(`Sending instruction to ${attached.label}...`);
              try {
                await attached.adapter.sendInstruction(confirmation.finalText);
                doggieLine("Instruction delivered.");
                spoken = replyLang === "hi" ? "समझ गया।" : "Understood.";
              } catch (err) {
                errorLine(`Could not deliver instruction: ${(err as Error).message}`);
              }
            } else {
              info("No agent attached — run `doggie attach` from another terminal to forward instructions.");
            }
            break;
          case "GENERAL":
            spoken = replyLang === "hi" ? "नमस्ते!" : "Hello!";
            break;
        }

        if (spoken) {
          try {
            onStateChange("SPEAKING");
            const outWav = path.join(os.tmpdir(), `doggie-reply-${Date.now()}.wav`);
            const speakResult = await worker.speak(spoken, replyLang, outWav);
            doggieLine(`"${spoken}"`);
            await playWav(speakResult.wav_path);
          } catch (err) {
            warn(`Could not speak reply: ${(err as Error).message}`);
          }
        }
      }
      onStateChange("IDLE");
    } catch (err) {
      onStateChange("ERROR");
      errorLine(`Voice turn failed: ${(err as Error).message}`);
      onStateChange("IDLE");
    } finally {
      busy = false;
    }
  });

  return {
    stop() {
      closed = true;
      rl.close();
      worker.stop();
    },
  };
}
