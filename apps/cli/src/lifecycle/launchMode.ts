import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WrappedProcessAdapter } from "@doggie/agents";
import type { AgentState } from "@doggie/shared";
import { readConfig } from "@doggie/shared";
import { SpeechWorkerClient, recordClip, resolveSpeechWorkerDir, piperBinary, recommendWhisperModel, playWav } from "@doggie/voice";
import { classifyIntent, filterAgentOutputForSpeech } from "@doggie/orchestrator";
import { transcribeClip } from "./transcribe.js";
import { confirmInstructionByVoice } from "./voiceConfirm.js";
import { startGeminiLiveVoice } from "./geminiLiveMode.js";
import { doggieLine, info, warn, errorLine } from "../terminal/banner.js";

/** Ctrl+T (0x14) — chosen over the spec's suggested Ctrl+Space because
 * Ctrl+Space is sent inconsistently across terminal emulators (some send a
 * NUL byte, some send nothing at all), making it unreliable to detect as a
 * single raw byte. Ctrl+T is free in bash/most shells and arrives as one
 * unambiguous byte, which is what this needs since we're scanning raw
 * passthrough bytes, not parsing escape sequences. */
const VOICE_TRIGGER_BYTE = 0x14;
const RECORD_SECONDS = 6;

export interface LaunchModeHandle {
  stop(): void;
}

/**
 * Waits for the wrapped session to respond to an instruction, then returns
 * whatever new text appeared since `before` — verbatim, not summarized.
 * There's no LLM reading or judging this content, by design: Doggie relays
 * raw output, it doesn't interpret it.
 *
 * Uses raw PTY idle time (WrappedProcessAdapter.getIdleMs()), not stripped
 * text length — found via real testing that stripped-text comparison is
 * wrong: a session showing a spinner (pure escape-sequence redraws, no new
 * visible characters) can strip down to zero added length, making genuinely
 * active work look falsely "done" the same way a completely silent command
 * would. Raw idle time at least counts spinner/redraw activity as "still
 * working," which matches how real interactive CLIs typically behave while
 * processing — but a wrapped command that produces *zero* bytes at all
 * while working (no output, no spinner, true silence) is indistinguishable
 * from finished by any output-based heuristic, full stop; that's a real,
 * inherent limit here, not something this can detect its way around.
 */
async function waitForResponse(adapter: WrappedProcessAdapter, before: string, maxWaitMs = 25000): Promise<string> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 800)); // let the command start before checking idle at all
  while (Date.now() - start < maxWaitMs) {
    if (adapter.getIdleMs() > 3000) break; // 3s of true byte-level silence => treat as settled
    await new Promise((r) => setTimeout(r, 400));
  }
  const after = adapter.getRecentOutput();
  return (after.startsWith(before) ? after.slice(before.length) : after).trim();
}

/**
 * Single-terminal mode: `doggie --launch "<command>"` spawns the target CLI
 * (e.g. kiro-cli-chat) inside a real PTY that Doggie owns (WrappedProcessAdapter,
 * built in Phase 4), mirrors its output directly to this terminal, and
 * forwards your keystrokes to it — so it looks and behaves like you just ran
 * that command normally. Press Ctrl+T to switch into a voice turn instead of
 * typing; everything else passes straight through.
 *
 * This answers a real request from using the two-terminal `doggie attach`
 * flow: it works, but needing a second terminal window just to connect an
 * already-open session is friction most people won't want for routine use.
 */
export function startLaunchMode(
  command: string,
  onStateChange: (s: AgentState) => void,
  onAttachmentChange: (info: { adapter: WrappedProcessAdapter; targetId: string; label: string } | null) => void
): LaunchModeHandle {
  const adapter = new WrappedProcessAdapter();
  let worker: SpeechWorkerClient | null = null;
  let voiceAvailable = false;

  try {
    const dir = resolveSpeechWorkerDir();
    voiceAvailable = fs.existsSync(path.join(dir, ".venv", "bin", "python")) && fs.existsSync(piperBinary(dir));
  } catch {
    voiceAvailable = false;
  }

  const config = readConfig();
  const geminiApiKey = process.env.GEMINI_API_KEY;
  let liveMode: ReturnType<typeof startGeminiLiveVoice> | null = null;
  if (config.sttProvider === "gemini-live") {
    if (geminiApiKey) {
      liveMode = startGeminiLiveVoice(adapter, geminiApiKey, onStateChange);
      liveMode.toggle(); // starts immediately — by request, no manual key needed to begin listening
    } else {
      warn("STT provider is set to 'gemini-live' but GEMINI_API_KEY isn't set — falling back to local voice.");
    }
  }

  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;

  adapter
    .attach(command, { cols, rows })
    .then(() => onAttachmentChange({ adapter, targetId: `wrapped:${command}`, label: `${command} (wrapped)` }))
    .catch((err) => {
      errorLine(`Failed to launch '${command}': ${err.message}`);
      process.exit(1);
    });

  adapter.observeOutput((chunk) => process.stdout.write(chunk));

  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  doggieLine(`Launched '${command}' in this terminal. Type normally to use it.`);
  if (liveMode) {
    info(
      "Gemini Live is listening continuously. Just talk — nothing reaches the terminal until you " +
        "say \"send\". Say \"response\"/\"status\"/\"update\" to hear an overview of what's happening. " +
        "Ctrl+C goes to the wrapped session, not Doggie."
    );
  } else if (voiceAvailable) {
    worker = new SpeechWorkerClient(recommendWhisperModel());
    info("Press Ctrl+T to speak an instruction (records 6s). Ctrl+C goes to the wrapped session, not Doggie.");
  } else {
    info("Voice not set up (`doggie voice setup`) — this terminal is plain pass-through to the wrapped session.");
  }

  let busy = false;
  const runVoiceTurn = async () => {
    if (!worker) {
      // Previously a silent no-op — Ctrl+T would appear to do nothing at
      // all, with the only explanation being a startup message easy to
      // miss or scroll past. Always say something when the key is pressed.
      warn("Ctrl+T pressed, but voice isn't set up (`doggie voice setup`) — ignoring.");
      return;
    }
    if (busy) {
      warn("Still processing the previous voice turn — ignoring this Ctrl+T.");
      return;
    }
    busy = true;
    try {
      onStateChange("LISTENING");
      doggieLine("\nListening...");
      const clipPath = path.join(os.tmpdir(), `doggie-launch-turn-${Date.now()}.wav`);
      await recordClip(clipPath, RECORD_SECONDS);

      onStateChange("TRANSCRIBING");
      await worker.waitUntilReady();
      const result = await transcribeClip(clipPath, worker);
      fs.rm(clipPath, () => {});

      const text = result.text || "(nothing recognized)";
      console.log(`\n\u{1F3A4} YOU SAID:\n"${text}"\n`);

      if (result.text) {
        const intent = classifyIntent(result.text);
        info(`intent: ${intent.type} (matched: ${intent.matchedRule})`);
        let spoken: string | null = null;
        if (intent.type === "AGENT_CONTROL") {
          onStateChange("INTERRUPTED");
          await adapter.interrupt();
          doggieLine("Sent interrupt (Ctrl-C) to the wrapped session.");
          spoken = "Stopping.";
        } else if (intent.type === "QUESTION") {
          const status = await adapter.getStatus();
          const busyOrIdle = status.state === "EXECUTING" ? "busy" : "idle";
          const recent = adapter.getRecentOutput();
          console.log(
            `\n(No LLM reads this session's content — Doggie can't actually answer "${result.text}". ` +
              `Here's the real recent output instead, so you can read it yourself:)\n` +
              "— — —\n" +
              (recent || "(nothing captured yet)") +
              "\n— — —\n"
          );
          spoken = `I can't read or summarize what the session actually said. It looks ${busyOrIdle} right now — I've printed its recent output above.`;
        } else if (intent.type === "INSTRUCTION") {
          onStateChange("WAITING_FOR_INPUT");
          const confirmation = await confirmInstructionByVoice(worker, result.text, result.language === "hi" ? "hi" : "en");
          if (!confirmation.send) {
            onStateChange("IDLE");
            return; // `finally` below still resets `busy`
          }
          onStateChange("SENDING_INSTRUCTION");
          const before = adapter.getRecentOutput();
          await adapter.sendInstruction(confirmation.finalText);
          doggieLine("Instruction delivered. Waiting for a response...");
          onStateChange("EXECUTING");
          const newOutput = await waitForResponse(adapter, before);
          console.log(
            `\n\u{1F4E4} OUTPUT:\n${newOutput || "(no new output yet — it may still be working; check the terminal above)"}\n`
          );
          // The printed block above is the raw output, untouched. What gets
          // SPOKEN is filtered (English only, per request) to strip known UI
          // chrome (separators, "Thought for Ns...", credits footer, status
          // bar) so it reads as the actual reply, not interface noise.
          const cleaned = newOutput ? filterAgentOutputForSpeech(newOutput, result.text) : "";
          spoken = cleaned
            ? cleaned.length > 400
              ? cleaned.slice(0, 400) + "... more printed above."
              : cleaned
            : newOutput
              ? "Got a response — see the terminal above (nothing left to speak after filtering interface noise)."
              : "Sent. No response yet.";
        } else {
          spoken = "Hello!";
        }
        if (spoken) {
          try {
            onStateChange("SPEAKING");
            const outWav = path.join(os.tmpdir(), `doggie-launch-reply-${Date.now()}.wav`);
            const speakResult = await worker.speak(spoken, result.language === "hi" ? "hi" : "en", outWav);
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
  };

  const onStdinData = (chunk: Buffer) => {
    // Gemini Live has no Ctrl+T ceremony — it's always listening once
    // started above, so every byte here is just normal typed input for
    // the wrapped session.
    if (liveMode) {
      adapter.writeRaw(chunk.toString("binary"));
      return;
    }
    const idx = chunk.indexOf(VOICE_TRIGGER_BYTE);
    if (idx === -1) {
      adapter.writeRaw(chunk.toString("binary"));
      return;
    }
    // Forward everything around the trigger byte, then run the voice turn —
    // keeps any keystrokes typed in the same chunk from being silently dropped.
    doggieLine("(Ctrl+T detected)"); // confirms the byte actually reached us, separate from what happens next
    const before = chunk.subarray(0, idx);
    const after = chunk.subarray(idx + 1);
    if (before.length) adapter.writeRaw(before.toString("binary"));
    void runVoiceTurn();
    if (after.length) adapter.writeRaw(after.toString("binary"));
  };
  process.stdin.on("data", onStdinData);

  const onResize = () => adapter.resize(process.stdout.columns ?? cols, process.stdout.rows ?? rows);
  process.stdout.on("resize", onResize);

  return {
    stop() {
      process.stdin.off("data", onStdinData);
      process.stdout.off("resize", onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
      worker?.stop();
      liveMode?.stop();
      onAttachmentChange(null);
      void adapter.detach();
    },
  };
}
