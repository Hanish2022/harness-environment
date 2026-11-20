import fs from "node:fs";
import type { WrappedProcessAdapter } from "@doggie/agents";
import type { AgentState } from "@doggie/shared";
import {
  GeminiLiveSession,
  streamMicrophone,
  createStreamingPlayer,
  LIVE_OUTPUT_SAMPLE_RATE,
  type MicStream,
  type StreamingPlayer,
} from "@doggie/voice";
import { classifyIntent, filterAgentOutputForSpeech, extractStatusLine } from "@doggie/orchestrator";
import { doggieLine, info, warn, errorLine } from "../terminal/banner.js";

export interface GeminiLiveVoiceHandle {
  toggle(): void;
  stop(): void;
  isActive(): boolean;
}

type Mode = "idle" | "listening";

// "SEND word only" — deliberately one plain, unambiguous English word
// chosen specifically so it stands out from normal (often Hindi/Hinglish)
// conversation and won't accidentally match real sentence content.
const SEND_WORD = /\bsend\b/i;
const RESPONSE_WORD = /\b(response|reply|status|update)\b/i;
const DIRECTORY_WORD = /\b(directory|directories|folder|folders|path|repo|repos|pwd)\b/i;

/**
 * Gemini Live replaces the old per-utterance record→transcribe→synthesize
 * cycle with one continuous session: the API's own voice-activity detection
 * decides when you start/stop talking, so there's no fixed recording window
 * to get wrong.
 *
 * By explicit request, this no longer carries any machinery ported over from
 * the old fixed-recording-window local-voice path: no confirm-before-send
 * step shaped as a question-and-wait-for-yes-no loop, and no polling/timeout
 * wait for the wrapped agent's response. The session also starts
 * automatically as soon as launch mode begins, not behind a manual toggle
 * key — "Live" means always listening while Doggie is running, full stop.
 *
 * Reported live: without any gate at all, *everything* heard — including
 * just thinking out loud, or telling Doggie something about how it should
 * behave — got typed straight into the wrapped agent's terminal and
 * executed. Replaced with an explicit, user-driven (not Doggie-asked) gate:
 * speech is only queued, never sent, until the user says the word "send" —
 * at which point whatever's queued goes to the wrapped agent in one shot.
 * Saying something containing "response"/"reply"/"status"/"update" instead
 * reads back an overview of the agent's current output, queuing nothing.
 * This is deliberately not the old confirm-step: Doggie never asks a
 * question or waits for yes/no (which is what caused the acoustic-feedback
 * loop earlier), it just listens and queues until the user themselves says
 * the one magic word.
 *
 * Mic/speaker acoustic feedback (no headset, laptop mic picking up Doggie's
 * own voice from the speakers) is real on this hardware — confirmed live:
 * saying "Hello" once produced a second identical "Hello" transcript ~8s
 * later with nothing said in between, and separately a misheard echo got
 * forwarded as a genuine instruction to the wrapped agent mid-session. Two
 * layers of defense against it, both silent (no prompts, no waiting, no new
 * keybinding — nothing like the confirm-step that was removed):
 *  1. Mic chunks aren't forwarded to Gemini while Doggie's own reply is
 *     playing (`doggieSpeaking`). This was tried once before and reverted —
 *     it only cleared the flag in `onTurnComplete`, so an interrupted
 *     generation left it stuck true forever and silently killed all further
 *     listening. Fixed this time: cleared on every path that can end a
 *     "Doggie is speaking" period (`onTurnComplete` AND `onInterrupted`),
 *     plus a hard timeout as a last-resort backstop so no missed callback
 *     can ever wedge it stuck again.
 *  2. Even so, gating isn't instant (there's always some window), so
 *     anything heard that closely matches what Doggie itself just said is
 *     treated as a likely echo and ignored rather than acted on — this is
 *     what would have caught the "I'm sending" case being forwarded as a
 *     real instruction.
 * Neither layer is perfect without real acoustic echo cancellation (not
 * attempted here — a much bigger piece of DSP work); a headset remains the
 * actually reliable fix if one becomes available.
 */
export function startGeminiLiveVoice(
  adapter: WrappedProcessAdapter,
  apiKey: string,
  onStateChange: (s: AgentState) => void
): GeminiLiveVoiceHandle {
  let session: GeminiLiveSession | null = null;
  let mic: MicStream | null = null;
  let player: StreamingPlayer | null = null;
  let mode: Mode = "idle";
  let pendingInputText = "";
  let pendingOutputText = "";
  let pendingToSend = "";
  let lastDoggieSpokenText = "";
  let doggieSpeaking = false;
  let speakingSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  const setDoggieSpeaking = (value: boolean) => {
    doggieSpeaking = value;
    if (speakingSafetyTimer) {
      clearTimeout(speakingSafetyTimer);
      speakingSafetyTimer = null;
    }
    if (value) {
      // Last-resort backstop: whatever happens, the mic can never stay
      // muted longer than this — the exact way this got stuck once before.
      speakingSafetyTimer = setTimeout(() => {
        doggieSpeaking = false;
        speakingSafetyTimer = null;
      }, 15000);
    }
  };

  const speakVerbatim = (text: string) => {
    doggieLine(`"${text}"`);
    lastDoggieSpokenText = text;
    session?.speakVerbatim(text);
  };

  const normalize = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");

  /** A short heuristic backstop for acoustic echo that slips through the mic gate above — not foolproof (a real "yes" right after Doggie says something short could false-positive), but better than acting on Doggie's own misheard voice as a live command. */
  const looksLikeEcho = (heard: string): boolean => {
    const h = normalize(heard);
    const s = normalize(lastDoggieSpokenText);
    if (h.length < 4 || s.length < 4) return false;
    return s.includes(h) || h.includes(s);
  };

  /**
   * Directory/folder questions used to be answered by scraping whatever the
   * wrapped terminal happened to have on screen — unreliable by nature (it
   * only shows the folder listing if the agent had *already* printed one
   * recently). Ground truth is cheaper and exact: Doggie's own process
   * already knows the real cwd it launched the wrapped agent in, so just
   * read the filesystem directly, the same way `pwd`/`ls` would.
   */
  const speakDirectoryInfo = () => {
    const cwd = adapter.getWorkingDirectory() ?? process.cwd();
    let folders: string[] = [];
    try {
      folders = fs
        .readdirSync(cwd, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name);
    } catch {
      // leave folders empty — still report the directory itself
    }
    console.log(`\n\u{1F4C1} DIRECTORY:\n${cwd}\n${folders.join(", ") || "(no subfolders)"}\n`);
    const text = folders.length
      ? `You're in ${cwd}. It has these folders: ${folders.join(", ")}.`
      : `You're in ${cwd}. No subfolders in it.`;
    speakVerbatim(text);
  };

  const speakOverview = async () => {
    const status = await adapter.getStatus();
    const busyOrIdle = status.state === "EXECUTING" ? "busy" : "idle";
    const recent = adapter.getRecentOutput();
    console.log(`\n\u{1F4E4} CURRENT OUTPUT:\n${recent || "(nothing captured yet)"}\n`);
    // The status-bar line (current directory, model, context %) is normally
    // stripped as noise, but it's exactly what a status/directory-type
    // question is actually asking for, so surface it on purpose here.
    const statusLine = recent ? extractStatusLine(recent) : null;
    const cleaned = recent ? filterAgentOutputForSpeech(recent) : "";
    const body = cleaned.length > 400 ? cleaned.slice(0, 400) + "... more printed above." : cleaned;
    const overview = [statusLine, body].filter(Boolean).join(". ");
    speakVerbatim(overview || `Looks ${busyOrIdle} right now — nothing to read out yet.`);
  };

  const handleCompletedUtterance = async (heard: string) => {
    if (!heard.trim()) return;
    if (looksLikeEcho(heard)) {
      info(`(ignored "${heard}" — looks like an echo of my own last reply, not a new instruction)`);
      return;
    }

    const intent = classifyIntent(heard);
    info(`intent: ${intent.type} (matched: ${intent.matchedRule})`);

    // Asking for the response/status/directory takes priority and never
    // touches the queue — you can check in on things without it counting as
    // "more to send". Gated on actually being a question (or the explicit
    // response/status/update words) — NOT on merely mentioning "folder" or
    // "directory" anywhere, which was a real bug: an instruction like
    // "explain overview.md in the Dubai folder... send" was getting hijacked
    // into reading the folder listing instead of being sent, just because
    // it mentioned a folder name as content, not as a question about cwd.
    if (intent.type === "QUESTION" || RESPONSE_WORD.test(heard)) {
      if (DIRECTORY_WORD.test(heard)) {
        speakDirectoryInfo();
      } else {
        await speakOverview();
      }
      return;
    }

    // Stop/cancel is safety-relevant, so it still acts immediately rather
    // than waiting to be queued-and-sent.
    if (intent.type === "AGENT_CONTROL") {
      onStateChange("INTERRUPTED");
      await adapter.interrupt();
      speakVerbatim("Stopping.");
      onStateChange("LISTENING");
      pendingToSend = "";
      return;
    }

    if (SEND_WORD.test(heard)) {
      const extra = heard.replace(SEND_WORD, "").trim();
      if (extra) pendingToSend = `${pendingToSend} ${extra}`.trim();
      const toSend = pendingToSend.trim();
      pendingToSend = "";
      if (!toSend) {
        speakVerbatim("Nothing queued to send yet.");
        return;
      }
      onStateChange("SENDING_INSTRUCTION");
      await adapter.sendInstruction(toSend);
      doggieLine("Instruction delivered.");
      speakVerbatim("Sent.");
      onStateChange("LISTENING");
      return;
    }

    if (intent.type === "GENERAL") {
      // A greeting/thanks/farewell — just chit-chat, not something to queue.
      // Gemini's own automatic spoken reply already covers it.
      return;
    }

    // Everything else is queued, not sent — the terminal is never touched
    // until the user explicitly says "send".
    pendingToSend = `${pendingToSend} ${heard}`.trim();
    info(`(queued, not sent yet — say "send" when ready: "${pendingToSend}")`);
  };

  const ensureSession = () => {
    if (session) return;
    session = new GeminiLiveSession(apiKey, {
      onActivityStart: () => {
        onStateChange("LISTENING");
      },
      onInputTranscript: (t) => {
        pendingInputText += t;
      },
      onOutputTranscript: (t) => {
        pendingOutputText += t;
        setDoggieSpeaking(true);
        onStateChange("SPEAKING");
      },
      onAudioChunk: (pcm) => player?.write(pcm),
      onInterrupted: () => {
        setDoggieSpeaking(false);
        player?.stop();
        player = createStreamingPlayer(LIVE_OUTPUT_SAMPLE_RATE);
      },
      onTurnComplete: () => {
        setDoggieSpeaking(false);
        const spoken = pendingOutputText.trim();
        pendingOutputText = "";
        if (spoken) lastDoggieSpokenText = spoken;
        const heard = pendingInputText.trim();
        pendingInputText = "";
        if (heard) console.log(`\n\u{1F3A4} YOU SAID:\n"${heard}"\n`);
        onStateChange("LISTENING");
        void handleCompletedUtterance(heard);
      },
      onError: (err) => errorLine(`Gemini Live error: ${err.message}`),
      onClose: () => {
        if (mode !== "idle") warn("Gemini Live session closed unexpectedly.");
      },
    });
    player = createStreamingPlayer(LIVE_OUTPUT_SAMPLE_RATE);
  };

  return {
    isActive: () => mode !== "idle",
    toggle() {
      if (mode === "idle") {
        ensureSession();
        mic = streamMicrophone((chunk) => {
          if (!doggieSpeaking) session?.sendAudioChunk(chunk);
        });
        mode = "listening";
        doggieLine("Live session started — speak anytime.");
        onStateChange("LISTENING");
      } else {
        mic?.stop();
        mic = null;
        session?.close();
        session = null;
        player?.stop();
        player = null;
        mode = "idle";
        setDoggieSpeaking(false);
        pendingToSend = "";
        doggieLine("Live session ended.");
        onStateChange("IDLE");
      }
    },
    stop() {
      mic?.stop();
      session?.close();
      player?.stop();
      setDoggieSpeaking(false);
    },
  };
}
