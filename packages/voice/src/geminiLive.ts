/**
 * Gemini Live API client: a persistent, bidirectional WebSocket session for
 * real-time audio-to-audio conversation, replacing the old per-utterance
 * record→transcribe→synthesize→play cycle with continuous streaming and the
 * API's own built-in voice-activity detection (no more fixed recording
 * windows or guessing when someone's done talking).
 *
 * Verified against the real API before building this (Gemini's model/API
 * surface has moved well past this project's training-data knowledge):
 *  - WebSocket endpoint, setup message, and audio-in message shapes.
 *  - inputAudioTranscription/outputAudioTranscription actually produce text.
 *  - A systemInstruction genuinely constrains behavior to "relay, don't be
 *    your own brain" — tested, got back a terse "Got it." acknowledgment
 *    instead of an independent opinionated response.
 *  - Asking it to speak given text verbatim actually works — tested, the
 *    output transcript matched the input text essentially word for word.
 *  - Output audio format (confirmed via the server's own mimeType field,
 *    not assumed): 24kHz, 16-bit PCM, mono, raw (no WAV header).
 */

const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const LIVE_INPUT_SAMPLE_RATE = 16000;
export const LIVE_OUTPUT_SAMPLE_RATE = 24000;

export interface GeminiLiveCallbacks {
  onInputTranscript?: (text: string) => void;
  onOutputTranscript?: (text: string) => void;
  onAudioChunk?: (pcm: Buffer) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onActivityStart?: () => void;
  onActivityEnd?: () => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

const DEFAULT_SYSTEM_INSTRUCTION =
  "You are Doggie, a calm, concise voice companion for a software developer working in a " +
  "terminal. You are NOT the developer's coding agent and you must not try to answer coding " +
  "questions, write code, or reason about their project yourself — a separate, already-running " +
  "coding agent handles all of that; your job is strictly to have brief, friendly spoken " +
  "exchanges with the human (greetings, short acknowledgments, confirming what to do next). " +
  "Keep every response to one short sentence. Always reply in the same language and script the " +
  "user just spoke in — if they spoke Hindi, reply in Hindi; if Hinglish (mixed Hindi-English), " +
  "reply the same mixed way; if English, reply in English. Never default to English when the " +
  "user spoke a different language. When the user's message is wrapped in [[VERBATIM]] and " +
  "[[/VERBATIM]] markers, speak the text between those markers exactly as written, word for " +
  "word, with no additions, no commentary, and do not say the markers themselves aloud.";

export class GeminiLiveSession {
  private ws: WebSocket;
  private ready: Promise<void>;
  private callbacks: GeminiLiveCallbacks;
  private closed = false;

  constructor(apiKey: string, callbacks: GeminiLiveCallbacks = {}, systemInstruction = DEFAULT_SYSTEM_INSTRUCTION) {
    this.callbacks = callbacks;
    this.ws = new WebSocket(`${ENDPOINT}?key=${apiKey}`);

    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => {
        this.ws.send(
          JSON.stringify({
            setup: {
              model: "models/gemini-3.8-live",
              generationConfig: { responseModalities: ["AUDIO"] },
              systemInstruction: { parts: [{ text: systemInstruction }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          })
        );
      });
      this.ws.addEventListener("error", () => reject(new Error("Gemini Live WebSocket error during connect")));
      this.ws.addEventListener("message", async (event) => {
        const msg = await this.parseMessage(event);
        if (msg?.setupComplete) resolve();
      });
    });

    this.ws.addEventListener("message", (event) => void this.handleMessage(event));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      this.callbacks.onClose?.();
    });
    this.ws.addEventListener("error", () => {
      this.callbacks.onError?.(new Error("Gemini Live WebSocket error"));
    });
  }

  private async parseMessage(event: MessageEvent): Promise<any> {
    const raw = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const msg = await this.parseMessage(event);
    if (!msg) return;
    if (msg.setupComplete) return; // handled by the `ready` promise above

    if (msg.voiceActivity?.type === "ACTIVITY_START") this.callbacks.onActivityStart?.();
    if (msg.voiceActivity?.type === "ACTIVITY_END") this.callbacks.onActivityEnd?.();

    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.callbacks.onInputTranscript?.(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.callbacks.onOutputTranscript?.(sc.outputTranscription.text);
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData?.data) this.callbacks.onAudioChunk?.(Buffer.from(part.inlineData.data, "base64"));
      }
    }
    if (sc.interrupted) this.callbacks.onInterrupted?.();
    if (sc.turnComplete) this.callbacks.onTurnComplete?.();
  }

  async waitUntilReady(): Promise<void> {
    return this.ready;
  }

  /** Streams one chunk of raw 16kHz/16-bit/mono PCM mic audio. */
  sendAudioChunk(pcm16: Buffer): void {
    if (this.closed) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: { audio: { data: pcm16.toString("base64"), mimeType: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}` } },
      })
    );
  }

  /** Tells the server the mic stream paused, flushing any buffered audio. */
  endAudioStream(): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  /** Asks Gemini to speak `text` verbatim (e.g. an attached agent's actual reply) rather than improvising. */
  speakVerbatim(text: string): void {
    if (this.closed) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: `[[VERBATIM]]${text}[[/VERBATIM]]` }] }],
          turnComplete: true,
        },
      })
    );
  }

  /** Lets Gemini improvise a short reply in its own voice (greetings, brief acknowledgments). */
  sendText(text: string): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }));
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}
