# Changelog

## Fixed directory-info hijacking real instructions — 2026-11-03

Reported live with two exact transcripts: "Explain overview.md file for me in Dubai MDB cashless
**folder**" and "...I want the directory structure in HTML file. **Send**." both got hijacked
into reading the folder listing back instead of doing what was actually asked — the second one
never even reached the terminal despite explicitly saying "send".

- Root cause: the directory-info check from the previous entry fired on *any* utterance
  containing "folder"/"directory"/"path" etc. anywhere, with no requirement that the utterance
  was actually a question about the current directory. Real instructions that simply mentioned
  a folder *by name*, as content, got misrouted the same way.
- Fixed: directory info now only fires when the utterance is already a genuine question
  (`classifyIntent` detecting a real question, or the explicit response/status/update words) —
  not merely because it mentions a folder somewhere. An instruction that happens to name a
  folder now correctly falls through to the send-queue instead of being hijacked.
- Verified against both exact phrases from the report plus the original working question case —
  all route correctly now (genuine directory question → directory info, folder-mentioning
  instruction → queued/sent normally, bare "status" → overview, unaffected).

## Fixed the actual root cause of "it reads old English banner text" + switched directory questions to real filesystem calls — 2026-11-03

Reported live: Doggie read out Kiro's startup ASCII-art banner and an English "Kiro CLI V3 is
now available" update notice when asked a status question, in a resumed session that had been
running for a while. User also pointed out directly: since directory/folder info is just a real
filesystem fact, Doggie should use `pwd`/`ls` directly instead of trying to read it off the
terminal screen at all.

- **Root cause, found in `packages/agents/src/wrappedAdapter.ts`**: `getRecentOutput()` joined
  the buffer from line 0 of up to 2000 lines of scrollback — meaning in any long-running session,
  "recent" output was actually the session's *first* lines, not its current state. The previous
  entry's status-line fix correctly found a real status line, but it was sitting right next to
  the startup banner near the top of a huge buffer, both getting pulled in. Fixed: now windows
  to only the last 200 lines. Verified directly: simulated a session with a banner followed by
  300 lines of filler followed by a genuinely recent line — confirmed the banner is now excluded
  and the recent line is included.
- Added a filter for lines made entirely of box-drawing/block/braille characters (ASCII-art
  logos, spinner frames) — these were passing straight through the existing noise filter since
  nothing recognized them as chrome. Verified against the actual reported banner shape.
- Implemented the user's own suggestion directly: `WrappedProcessAdapter` now exposes
  `getWorkingDirectory()` (the real `cwd` it launched the wrapped agent in — ground truth, not
  inferred from screen text), and a directory/folder-type question ("directory"/"folder"/"path"/
  "repo"/"pwd") now answers by reading the real filesystem (`fs.readdirSync`) directly — the same
  thing `pwd`/`ls` would show, with zero dependency on what the wrapped agent happens to have
  printed recently. Checked before the general status-overview path, since it's unambiguous,
  read-only, and strictly more reliable for this specific question type.

## Fixed real questions being queued as instructions, and the status line being thrown away — 2026-11-03

Reported live with a full transcript: asking "aapka directory path kya hai?" (Hindi, genuine
question) got silently queued as pending instruction content instead of answered, piling up into
a long, confusing blob while Gemini improvised unrelated chit-chat back ("which directory are you
in?" — it has no idea, it was never told). And separately, when the terminal output *was* read
back, it still said it couldn't tell the directory even though the terminal's own status bar
(`kiro_default · claude-opus-4.8 · ◔ 16% ~/vol1/kiosk`) shows it plainly.

- Root cause #1: the previous entry only routed the literal words "response"/"status"/"update" to
  the real-data overview — a genuine Hindi/English question ("kya"/"kaun"/"kaisa"/wh-words) fell
  through to the generic "queue it" bucket instead, same as any instruction fragment. Now any
  `classifyIntent` QUESTION match routes to the overview too, reusing the same bilingual
  question-word detection already built and tested elsewhere in this project — not a new parser.
- Root cause #2: `filterAgentOutputForSpeech` deliberately strips the status-bar line as noise
  (correct for reading back a conversational reply) — but that line is the *only* place the
  current directory/model/context actually appear, so stripping it before a status/directory
  question made an accurate answer impossible by construction, independent of any other bug.
  Added `extractStatusLine()` (packages/orchestrator) to pull that line out on purpose for the
  overview path specifically; the normal conversational-reply filtering is untouched.
- Verified `extractStatusLine` against the real sample transcript from the report — correctly
  extracts the status line with the real path intact, while `filterAgentOutputForSpeech` still
  correctly drops it from a normal reply, confirming neither path regressed the other.
- Not addressed, and flagged honestly: some of the queued text in the report looked like
  transcription hallucination (fragments of Punjabi/Spanish never actually said) — a known
  failure mode of audio-to-text models on background noise/silence, not something this change
  attempts to filter; a real test will show whether it's frequent enough to need its own guard.

## Gated the terminal behind an explicit "send" word — 2026-11-03

Reported live (real transcript): with zero gating, *everything* heard — including the user
telling Doggie "don't process whatever I say right now" — got typed straight into the wrapped
Kiro session and executed as a real command. Also asked for a way to get a summarized overview
of what the agent is doing, on request, distinct from just talking.

- New design, deliberately NOT the old confirm-step (no question asked, no wait, no loop risk):
  speech is queued (`pendingToSend`) but never sent to the wrapped agent until the user says the
  literal word "send" — at which point everything queued since the last send goes in one shot.
  Verified the trigger regex (`\bsend\b`) against real phrases including word-boundary edge cases
  ("sending flowers" must not match) — all correct.
- Saying something containing "response"/"reply"/"status"/"update" instead reads back a
  summarized overview of the agent's current terminal output (capped at 400 chars, "...more
  printed above" beyond that) — verified the matching regex the same way, including that
  "responsible" doesn't false-match "response".
- A plain greeting/thanks/farewell (GENERAL intent) is still just chit-chat — not queued, not
  sent, Gemini's own automatic reply covers it, same as before.
- "Stop"/"cancel"/Hindi "ruko" still interrupts the wrapped agent immediately rather than being
  queued, since that's safety-relevant and shouldn't wait on the user remembering to say "send".
- Updated the launch-mode startup message to explain the new behavior up front.

## Fixed Gemini Live replying in English to Hindi speech — 2026-11-03

Reported live: speaking Hindi got an English spoken reply back. The system instruction
(`packages/voice/src/geminiLive.ts`) never told Gemini what language to reply in at all, and
since the instruction itself is written in English, the model was defaulting to English
regardless of what language the user actually spoke. Added an explicit instruction to mirror
the user's language and script (Hindi → Hindi, Hinglish → Hinglish, English → English) instead
of defaulting. Rebuilt and reinstalled — not independently verifiable without a real Gemini
Live session and real speech, so this needs a live retest like every other voice-behavior change
in this project.

## Re-added mic-mute (properly fixed) + a new echo-text filter, with explicit sign-off — 2026-11-03

Reported live, right after the previous entry's changes shipped: "Hello" produced a second
identical "Hello" transcript ~8s later unprompted, and separately a misheard phrase ("I'm
sending") got forwarded as a real instruction into a live Kiro session mid-"Thinking". Root
cause is physical, not software: laptop speaker output bleeding acoustically into the laptop's
own mic, with no headset and no real echo cancellation anywhere in this pipeline — Gemini's own
spoken replies were being picked back up and treated as fresh user speech.

- Asked the user directly before re-adding anything they'd explicitly told me to remove earlier:
  confirmed no headset is available, and got explicit sign-off to re-add mic-muting during
  Doggie's own playback, this time fixed properly.
- Re-added the `doggieSpeaking` mic-gate, but this time cleared on *every* path that can end a
  "Doggie is speaking" period — `onTurnComplete` AND `onInterrupted` (the previous version only
  cleared it on the former, which is exactly how it got stuck true forever last time) — plus a
  hard 15s timeout as a last-resort backstop so no missed callback can wedge it stuck again,
  regardless of what edge case might cause one.
- Added a second, independent layer: a lightweight text-similarity check (`looksLikeEcho`) that
  ignores anything heard that closely matches what Doggie itself just said, in case a fragment
  of its own voice slips past the mic gate's timing window. Not a prompt, not a wait, not a new
  keybinding — a silent heuristic. Verified against 7 realistic transcript pairs (echoed phrases,
  genuinely different user instructions, short words) — all matched the expected verdict.
- Neither layer is real acoustic echo cancellation (that's a much bigger DSP undertaking, not
  attempted here) — a headset remains the actually reliable fix if one becomes available later.

## Stripped Gemini Live down further by request: no wait-timer, no Ctrl+T — 2026-11-03

User asked again, explicitly, to confirm the confirm-step and English-only removal from the
previous entry, and to additionally remove the remaining response-wait timer and the Ctrl+T
toggle requirement — "we literally don't need anything with gemini live."

- Confirmed the confirm-before-send step and its English-only word matching were already gone
  (previous entry) — nothing left to remove there.
- Removed the `waitForResponse` poll (800ms/400ms/3000ms/25000ms) from `geminiLiveMode.ts`
  entirely — the last timer anywhere in this path. An INSTRUCTION is now sent and acknowledged
  ("Sent.") immediately, with no wait. A QUESTION ("what happened?") now actually reads and
  speaks the wrapped session's *current* output (it previously always said "I can't read or
  summarize the session's output", which was simply wrong for this adapter type — it can read
  it, and now does) — this is how you check on progress, read fresh on demand, not on a timer.
- Removed the Ctrl+T requirement for Gemini Live specifically: the session now starts
  automatically the moment `--launch` begins (`liveMode.toggle()` called once, immediately,
  instead of waiting for a keypress), and Ctrl+T is no longer intercepted at all while Gemini
  Live is active — every byte just passes straight through to the wrapped agent as normal typed
  input. (Ctrl+T is unchanged for the separate local-voice path, which wasn't part of this
  complaint and still needs a manual trigger since it has no server-side VAD of its own.)
- Verified: full TS rebuild compiles clean; ran `doggie --launch` end-to-end with `gemini-live`
  configured but no API key set (the fallback path), confirmed it starts, falls back to local
  voice with a clear warning, and `doggie stop` shuts down cleanly with no leftover processes.
  Could not verify the live, in-session behavior itself (needs a real API key and real human
  speech, neither available here) — that still needs a real test on your end.

## Reverted a mic-mute regression I'd just introduced — 2026-11-03

Reported live, immediately after the previous entry's fix shipped: "gemini live isn't detecting
anything correctly." Caused by my own prior change in this same session — reverted it rather
than trying to patch around it, per explicit instruction not to make it worse.

- Root cause: the `doggieSpeaking` flag added below (to stop forwarding mic audio to Gemini
  while Doggie's own reply was playing, as an echo mitigation) was set `true` in
  `onOutputTranscript` but only ever reset to `false` in `onTurnComplete` — not in
  `onInterrupted`. If Gemini's own turn ever got interrupted instead of completing normally,
  the flag stayed stuck `true` forever, and the mic-forwarding gate then silently dropped
  every subsequent mic chunk for the rest of the session — indistinguishable from "voice
  detection stopped working."
- Removed the whole `doggieSpeaking` mic-gating mechanism rather than just fixing the missed
  reset — it was unverified (no real live test before shipping it) and the user explicitly
  asked for Gemini Live's own detection to be trusted directly, with no extra Doggie-side
  logic layered on top of it. Mic audio is forwarded unconditionally again, exactly as before
  that change. The acoustic-echo risk this was meant to mitigate is back as a known, accepted
  tradeoff rather than a half-fixed mechanism with its own bug.
- Confirmed the only timers remaining anywhere in the Gemini Live path (`apps/cli/src/lifecycle/
  geminiLiveMode.ts`'s `waitForResponse`: 800ms/400ms/3000ms/25000ms) are unrelated to voice
  detection — they poll the *wrapped terminal's own output* for idleness after an instruction
  is sent, since Gemini Live has no visibility into that terminal at all. Left in place; removing
  them would break reading the agent's response back, not fix voice detection.

## Removed the Gemini Live confirm-before-send step — fixed a live infinite-loop bug — 2026-11-03

Reported live: a Gemini Live session speaking Hindi ("मैं बिल्कुल") got stuck repeating "Should
I send this, or do you want to say more?" forever. User asked to remove the confirm-before-send
step entirely ("I don't think we need all of this with Gemini Live now") and to drop the
English-only assumption baked into it, and to redesign around what actually fits Gemini Live.

- Root cause was two compounding issues:
  1. The confirm flow's yes/no matching (`SEND_EXACT`/`DECLINE_EXACT`, copied from the older
     local-voice confirm step) only recognized English words. A non-English reply always fell
     into its "treat as more content, re-ask the same question" branch.
  2. Doggie's own spoken prompt was picked up acoustically by the still-open, continuously
     streaming microphone (no echo cancellation anywhere in this pipeline) and fed back into
     Gemini as if the user had said it — so re-asking the same question kept re-triggering
     itself, forever.
- Removed the confirm-before-send step completely: an INSTRUCTION is now sent to the wrapped
  agent as soon as it's heard, no confirmation round-trip — Gemini Live's own continuous,
  natural turn-taking is a better fit than a step ported from the old fixed-recording-window
  pipeline. This also removes the only English-only gate in this file (it no longer exists).
- Fixed the other half of the same echo problem: mic audio is no longer forwarded to Gemini
  while Doggie's own reply audio is actively playing (gated on a `doggieSpeaking` flag, set
  between `onOutputTranscript` and `onTurnComplete`). Tradeoff made explicit: this means
  voice barge-in (interrupting Doggie mid-sentence) no longer works, since that depended on
  the mic staying open during playback — not something this project had verified live yet
  anyway (ARCHITECTURE.md's own gap list already called this out), so this prioritizes not
  getting stuck in a feedback loop over an unverified nice-to-have.

## Fixed a real crash: EPIPE on a dead aplay pipe took down the whole process — 2026-11-03

Reported live: during a real Gemini Live session, after Doggie spoke a reply ("I can't read or
summarize the session's output...") the whole thing crashed with `❌ Unexpected error: write
EPIPE` and shut down.

- Root cause: `createStreamingPlayer` (packages/voice/src/playback.ts) pipes PCM audio to `aplay`
  via `proc.stdin.write()`, wrapped in a `try/catch`. But when the pipe's reader has already died,
  Node delivers that failure as an async `'error'` event on the stream, not a thrown exception —
  the `try/catch` only catches synchronous throws, so it never caught this. With no `'error'`
  listener on `proc.stdin`, the event became an uncaught exception, and the global crash handler
  in `start.ts` treats any uncaught exception as fatal.
- Found the identical unguarded pattern in two other places that write to a child process's
  stdin without an error listener: `OverlayProcess` (apps/cli/src/lifecycle/overlayProcess.ts)
  and `SpeechWorkerClient` (packages/voice/src/speechWorkerClient.ts) — fixed both the same way,
  since a dead overlay or speech-worker process could trigger the exact same crash class.
- Verified by reproduction, not just inspection: wrote a harness that spawns a real `aplay`,
  writes to it continuously, and kills it out-of-band mid-stream (closely mirroring the real
  race — just waiting for the child to exit cleanly first, as an earlier naive repro attempt did,
  never actually reproduced it, since Node marks the stream non-writable once it notices the
  exit, and the existing guard already blocks writes at that point). Confirmed the unfixed build
  crashes with the exact same `EPIPE write EPIPE` message from the real incident, and the fixed
  build survives the identical race, run back-to-back against the same harness.

## Major pivot: 2D sprite avatar — 2026-11-03

User asked to drop the hand-built 3D `wgpu` placeholder avatar for a 2D spritesheet-based pet
(codex-pets style), built as our own native renderer rather than adopting a third-party
(typically Tauri-based) pet tool, which would violate the spec's no-Electron/no-Tauri constraint.

- Investigated `npx codex-pets add <name>` as an asset source. The user's first pick, `messi`,
  turned out to be an unauthorized caricature of the real footballer Lionel Messi — declined to
  use it despite direct pushback, and used `blue-curly-pup` as a safe placeholder while awaiting
  a different choice. User then picked `monthly-salary-cat` (a generic office-worker-cat meme,
  no real person or named franchise) — vetted and used.
- Confirmed via the asset source's own API that pets in this catalog share one grid convention
  (1536×1872 atlas, 192×208 cells, 8 cols × 9 rows), so the loader isn't pet-specific.
- Rewrote `native/overlay/src/renderer.rs` from a lit/textured 3D mesh pipeline (MVP matrix,
  depth buffer) to a minimal 2D textured-quad pipeline: one window-filling quad, alpha blending,
  UV sub-rect selects the current sprite cell. Added `sprite.rs` (grid constants + a
  state→row mapping chosen by inspecting what each row of this specific sheet depicts) and
  rewrote `animation.rs`'s `Animator` to tick through a row's frames on a timer instead of
  computing a 3D pose (no skeleton exists anymore to pose).
- Removed now-orphaned 3D-only code: `mesh.rs` (primitive/placeholder-mesh generation, GLB
  loading), the `gltf`/`glam` Cargo dependencies, the `doggie avatar <path.glb>` command,
  `DoggieConfig.avatarModel`, and the overlay's `--model` CLI flag — none of this has a
  equivalent in a 2D sprite-cell model.
- Added a bottom-right-of-screen default window position (previously a fixed `(100, 100)`),
  per the user's explicit "keep it in bottom right" request; still draggable and still persists
  a dragged position across restarts exactly as before.
- Verified for real, not assumed: built and ran the binary, captured real `xwd` screenshots
  (the same verification method used throughout this project) of the Idle, Listening and
  Executing states, confirmed clean alpha-blended output with no seams, confirmed per-state UV
  rects sample the correct row, and confirmed the default window position lands in the
  screen's bottom-right corner on the real 1920×1080 display this was tested on.

## Major pivot: Gemini Live voice — 2026-11-03

User explicitly asked to replace the local Whisper+Piper STT/TTS pipeline with Gemini Live
(real-time audio-to-audio), confirmed understanding it's a paid, continuously-streaming cloud
service (not free, not brief opt-in clips). Implemented as `doggie voice provider gemini-live`,
`--launch` mode only so far. Everything below was verified against the real API before being
relied on, not assumed — this project's prior knowledge of Gemini predates real API changes:

- Found the real WebSocket protocol (`wss://.../BidiGenerateContent`), setup message shape, and
  audio message formats via Google's current docs (not training-data guesses).
- Verified live: connecting, streaming 16kHz PCM audio, receiving automatic voice-activity
  detection events, input/output transcripts, and 24kHz PCM audio output (confirmed via the
  server's own `mimeType` field, not assumed).
- Verified a systemInstruction can genuinely constrain Gemini to "relay, not an independent
  brain" — sent real instruction-like audio, got back a terse "Got it" instead of an opinionated
  reply, consistent with the project's established "Doggie doesn't need his own brain" design.
- Verified Gemini can be made to speak arbitrary text **verbatim** (critical for relaying an
  attached agent's actual output, not a paraphrase) — tested, the spoken-back transcript matched
  the input text essentially word for word.
- Verified the trickiest architectural assumption before relying on it: mixing continuous
  `realtimeInput` audio streaming with an injected `clientContent` text message (used for the
  confirmation prompt) in the same session — tested with simulated continuous silence streaming
  plus a mid-stream text injection; got the expected spoken response back correctly.
- Built `GeminiLiveSession` (packages/voice), continuous mic streaming and streaming audio
  playback (replacing fixed-duration recording and complete-file-then-play), and
  `geminiLiveMode.ts` wiring it into the existing orchestrator/agent-forwarding logic — Ctrl+T
  now toggles a continuous Live session on/off instead of triggering one fixed-length recording.
  Reuses the same deterministic confirm-by-exact-phrase logic as the local path (no LLM decides
  whether to send — Gemini speaks the question, our own code still parses the yes/no).
- **Known gap, not yet done**: only wired into `--launch` mode, not the two-terminal
  `doggie attach` flow. Full live multi-turn conversation flow (confirmation prompt interleaved
  with continuous streaming) verified mechanism-by-mechanism, but not end-to-end with real human
  speech — that still needs a live test, same honest caveat as every voice feature this session.

- Added a safeguard for a reported "reading 12345678 repeatedly" symptom with no real output
  shown: best available diagnosis (couldn't get a full repro) is Whisper hallucinating a run of
  digits on a near-silent confirmation-loop recording — a documented Whisper failure mode, not
  specific to this project. Added a check that treats a digits-only transcription as "nothing
  said" (re-ask) rather than appending hallucinated numbers as real instruction content.
- Found and fixed a real bug in the voice confirmation flow, reported live: saying something
  like "yes I want to say more, also check the other service" caused the *entire* utterance —
  including the real new content — to be discarded, because the keyword matching looked for
  "more" anywhere in the text rather than treating only a short, exact "yes"/"no" as a real
  answer. Also caught a related false-positive risk: "confirm" was in the send-word list as a
  substring match, so an unrelated sentence mentioning "confirm" (e.g. "I want to confirm the
  server is working too") would have falsely triggered send. Fixed by anchoring the match to the
  whole trimmed utterance — anything longer than a short exact phrase is now always treated as
  real content to append, regardless of which words it happens to contain. Verified against both
  the original test cases and the exact failing sentence.
- Found and fixed a real timeout bug: `speak()` was still on the default 30s client timeout
  (never got the same bump `transcribe()` got earlier for the same reason) — each call spawns a
  fresh Piper subprocess with no persistent model, so a long reply under real system load
  (GPU-rendered avatar + wrapped agent session competing for CPU/RAM) could exceed 30s even
  though an isolated benchmark showed ~7s for a 341-char reply. Bumped to 60s.
- Fixed a real silent-failure bug in `--launch` mode: pressing Ctrl+T when voice wasn't fully set
  up did nothing visible at all — now it always prints something (either confirming the key
  reached Doggie, or saying plainly that voice isn't ready), so a non-working Ctrl+T is never
  silently mysterious.
- Reverted the TTS voice from `en_US-ryan-high` back to `en_US-norman-medium` after a real
  regression report: whispery, broken-sounding audio during the longer confirm-flow replies.
  Investigated what I could without being able to actually hear audio myself — checked the
  generated WAV's sample rate, checked for clipping/abnormal silence gaps, checked for a
  speak/playback race condition in the new voice-confirm flow — found nothing conclusively wrong
  in the signal or the code, so couldn't pin an exact root cause. Reverted to the known-good
  voice that had many hours of working playback before the swap, rather than keep a regression
  live while still investigating. `en_US-ryan-high`'s files are left on disk if it's worth
  revisiting with more specific diagnostic info from a live test.
- Replaced the keyboard-based "press Enter to confirm" step with a fully voice-driven one, per
  explicit request: Doggie now speaks "should I send this, or do you want to say more?" and
  listens for a short spoken answer instead of requiring a key press. Deterministic keyword
  matching (send/yes/go ahead vs. no/wait/more — no LLM), with anything else said treated as
  additional instruction content and appended before asking again (up to 2 rounds, then defaults
  to *not* sending rather than guessing). Also bumped the initial recording window from 4s to 6s
  per request, in both the two-terminal `doggie attach` flow and `--launch` mode.
- Redesigned the placeholder avatar after direct user feedback it looked bad — confirmed by
  actually looking at a screenshot myself: the head and muzzle were two separately-visible
  spheres creating an ugly pinched seam, the ears were sharp "shark fin" cones, and the color was
  a flat muddy grey-blue. Fixed by nesting the muzzle deeply into the head sphere (hides the
  join), switching ears to rounded sphere-based shapes, and using a richer saturated blue with a
  cream muzzle for contrast. Verified with a before/after screenshot comparison, not just
  described.
- Fixed the output-capture bug properly after it reappeared against the user's real Kiro session
  (the regex-based "strip ANSI + collapse \r" approach from the previous fix still failed — real
  Kiro output kept coming back empty). Replaced it with a real terminal emulator
  (`@xterm/headless`) in `WrappedProcessAdapter`: PTY bytes are now written into an actual virtual
  screen buffer, and `getRecentOutput()` reads back what's genuinely displayed via
  `buffer.active.getLine(y).translateToString()`. This correctly handles cursor-addressed
  full-screen redraws (which a line-oriented regex fundamentally can't), confirmed against both a
  spinner+color-code test and a harder cursor-save/restore status-bar simulation — both now
  capture the real response correctly.
- Added a confirmation step before sending any voice-forwarded instruction: Doggie now prints
  what it's about to send and waits for Enter (anything else cancels) in both the two-terminal
  `doggie attach` flow and `--launch` single-terminal mode, instead of auto-sending immediately.
- Investigated STT/TTS quality complaints concretely rather than guessing: tested `faster-whisper`
  `medium` against the known "Doggie → mangled name" failure — ~19s inference and ~116s first
  load for **no real accuracy improvement** ("Daudi is online" instead of "Doggie"), so medium
  was *not* adopted as default; this specific mispronunciation looks like an inherent Whisper
  vocabulary gap for an uncommon name, not something model size fixes. Switched the default
  English TTS voice from `en_US-norman-medium` to `en_US-ryan-high` (Piper's "high" quality tier,
  better vocoder) for a real, low-risk quality improvement. No "high" tier exists for Hindi in
  Piper's catalog, so that voice is unchanged.
- Built an output filter (`packages/orchestrator/src/outputFilter.ts`) so Doggie speaks the real
  conversational reply instead of a raw dump of terminal UI chrome (separator lines, "Thought for
  Ns..." indicators, credits footers, status-bar chrome, bare status words). English only, by
  request. Pattern-based, no LLM, tuned against Kiro's actual CLI conventions. Tested against the
  user's own real transcript, not an invented fixture — caught and fixed a real bug in the
  process: a "rationale aside" wraps across multiple physical terminal lines with no per-line
  marker on the continuation, which a first version let leak through; fixed with block-aware
  (not purely line-by-line) filtering, with a regression test pinned to that exact transcript.
- Implemented what the user actually wanted: Doggie relays the real output after forwarding an
  instruction in `--launch` mode, rather than just saying "Understood" and stopping. Took two
  iterations to get right, both caught by testing before shipping:
  1. First version used "no new output for 1.5s" to decide the response was complete — tested
     against a deliberately slow command and found it cuts off mid-wait, capturing only the
     echoed instruction, because a session that's silently *working* (no output yet) looks
     identical to "done" under that heuristic. This was the literal bug the user reported live.
  2. Switched to raw PTY idle time instead of comparing stripped-text length — but a second test
     (simulating a realistic spinner via repeated carriage-return redraws) revealed the ANSI
     stripping could reduce spinner-only activity to zero added characters, which would have
     caused the exact same false "it's done" detection for any real agent CLI that shows a
     spinner while thinking rather than going fully silent. Fixed by tracking raw byte arrival
     (`getIdleMs()`), not stripped-text length, for the "is it still working" signal.
  Also had to fix a second bug introduced while cleaning up spinner noise from the displayed
  output: collapsing carriage-return overwrites naively turned a normal CRLF line ending into an
  empty string, silently deleting real content. Fixed by normalizing `\r\n` to `\n` *before*
  collapsing bare `\r` overwrites. Both fixes verified against real spinner/color-code test cases,
  not just reasoned about — this is the pattern across this whole project: a plausible-sounding
  fix was wrong twice in a row here, and only testing against a realistic scenario caught it.
  Known remaining limit, stated honestly: a wrapped command that produces truly zero output while
  working (no text, no spinner) is indistinguishable from "finished" by any output-based
  heuristic — there's no way around that without a real signal from the agent itself.
- User hit a real, bad UX bug: asking Doggie a genuine question ("what was the last chat I did?")
  got the literal internal debug string spoken back ("wrapped pty, 16s since last output") as if
  it were an answer. Fixed in two parts: (1) QUESTION replies no longer speak raw status-detail
  strings, ever; (2) since `WrappedProcessAdapter` already captures the session's real output,
  added a rolling buffer (`getRecentOutput()`, ANSI escape codes stripped so it's readable) and
  print that for real instead — honest that there's still no LLM summarizing or answering based
  on it (by design, spec section 10), but at least the user gets the actual recent output to read
  themselves instead of a meaningless timer phrase. Verified the ANSI stripping against a real
  color-coded terminal output.

- User asked for a single-terminal workflow (no separate `doggie attach` window). Added
  `doggie --launch "<command>"`: wraps the target CLI in a real PTY (`WrappedProcessAdapter`,
  built in Phase 4 but not wired to a CLI flag until now), mirrors its output into Doggie's own
  terminal, forwards keystrokes to it, and uses Ctrl+T (not the spec's Ctrl+Space, which is
  unreliable across terminal emulators as a single detectable byte) to trigger a voice turn
  instead of typing. Verified: input forwarding, the trigger byte splitting surrounding text
  correctly, and specifically that Ctrl+C reaches the wrapped session without killing Doggie.

- Tested the Gemini provider against the user's real API key (confirmed the key itself works —
  valuable since its format didn't match what training data expected). Default model
  `gemini-3.8-flash` consistently returned HTTP 503 "high demand" with a real key;
  `gemini-3.5-flash-lite` and `gemini-2.5-flash` both worked and produced real transcriptions.
  Switched the default to `gemini-3.5-flash-lite`. `gemini-2.5-flash-lite` 404'd as "no longer
  available to new users" during the same test — this API's model lineup is moving fast even
  within a single testing session, not just since this project's training cutoff.

- User asked for the actual Power Rangers SPD "Doggie Cruger" look. Declined to fetch any
  real-world 3D model of that copyrighted character (the original spec explicitly prohibits
  this, and licensing on the free-model sites checked was uniformly unclear/needs manual
  verification per-model). Instead improved the original procedural placeholder: sharper,
  more upright ears, a gold chest badge, and shoulder epaulettes — a nicer "commander" look
  with zero copyright exposure, verified by screenshot before/after.

- Found (via a real orphaned overlay process spotted during a regression test) and fixed a real
  bug: `start.ts` only handled `SIGINT`/`SIGTERM`, not `SIGHUP` — the signal sent when the
  terminal window Doggie is running in gets closed. Node's default SIGHUP behavior is to exit
  immediately with no cleanup, orphaning the overlay child. Fixed by routing SIGHUP through the
  same clean-shutdown path. Reproduced before and after with `kill -HUP` to confirm.

- Real-world testing (user's actual microphone, not synthetic test clips) surfaced low-confidence,
  sometimes-wrong language auto-detection (English speech misheard as Hindi/Arabic, with the
  words themselves transcribed correctly but in the wrong script). Added `doggie voice lang
  <auto|en|hi>` to force the language and skip unreliable auto-detection.
- Added optional cloud STT: `doggie voice provider <local|gemini>`. Investigated Claude's API
  first — it has no audio input capability at all, so there's no "Claude provider" to build.
  Gemini's API does support audio; added as strictly opt-in (local stays default), API key read
  from `GEMINI_API_KEY` only (never persisted to config, never logged), falls back to local with
  a warning if the key is missing. Verified against Google's *current* API docs rather than
  assumed from training data, since the model lineup has moved well past what training knowledge
  covers — confirmed the request reaches the real endpoint correctly (clean `API_KEY_INVALID`
  from Google's server with a deliberately bad key, not a malformed-request error).

## Phase 6 — 2026-11-03

- Added `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/package-linux.sh` — all real and
  tested, not placeholders. `install.sh` was verified from a fully minimal environment (no pnpm,
  no prior setup); `package-linux.sh` produces a 33MB tarball (deliberately excluding the
  ~1.3GB of lazily-downloaded voice models) that was extracted fresh and installed/launched with
  no Rust toolchain present, end to end.
- Found and fixed a real bug this testing surfaced: `install.sh`'s repo-root path detection broke
  when copied into a packaged tarball (assumed a fixed relative path that package-linux.sh
  doesn't preserve) — fixed by detecting the actual layout instead of assuming one.
- Reclaimed ~745MB of Rust build cache (`cargo clean`, binary kept) given this machine's
  persistent disk pressure.
- Error-handling pass: clean error messages instead of raw crash dumps for one-shot commands;
  `start.ts` now routes crashes through the same clean-shutdown path as Ctrl+C, so a bug can't
  orphan the overlay child process.
- Known gaps, documented rather than hidden: `doggie config` still unimplemented; macOS
  packaging/verification not done (no Mac available); a Commander routing quirk sends unknown
  subcommands to the default `start` action instead of erroring.

## Phase 5 — 2026-11-03

- Built `packages/orchestrator`: a deterministic, keyword/pattern-based intent classifier
  (INSTRUCTION/QUESTION/AGENT_CONTROL/GENERAL) across English, Hindi, and Hinglish — no LLM API,
  per spec. Genuinely unit-tested with `node --test`, including the spec's own section-10 worked
  examples verbatim; all pass.
- Wired it into the live voice loop: each turn is classified and branches for real (interrupt the
  attached agent / ask its status / forward as an instruction / just reply), each branch speaking
  a short Piper reply.
- Extended `AgentState` with `SPEAKING` (the spec's avatar animation table needed it; the
  original Phase 1 type, written before the animation table was implemented, didn't have it).

## Phase 4 — 2026-11-03

- Asked the user directly about tmux rather than guessing: no passwordless sudo on this machine
  to install it, and a found prebuilt static tmux binary was correctly blocked by the harness as
  an unverified third-party executable. The user confirmed they run agents in a plain terminal,
  not tmux — so the tmux adapter is explicitly not built (would be unverified/unused code);
  effort went into a plain-terminal path instead.
- Built `packages/agents`: the `AgentAdapter` interface from spec section 8, a `PlainPtyAdapter`
  (input injection via direct PTY-slave-device writes — validated against a disposable `cat`
  process with terminal echo deliberately disabled first, to rule out a false positive, before
  trusting the mechanism), and a `WrappedProcessAdapter` (full read+write via `node-pty`, which
  compiled cleanly with no new system packages).
- `doggie sessions` detects real running agent processes by scanning `ps` — tested against actual
  live processes on this machine (this project's own Claude Code session, and the user's real
  Kiro CLI session), not mocks.
- `doggie attach <pid>` requires interactive confirmation, only offers pids from `doggie
  sessions`' own detection, and the adapter re-checks the target is still alive and on the same
  tty before every write. Never tested against a real live agent session — all input-injection
  testing used disposable throwaway processes, since "proving it works" against the user's actual
  session would itself be an unwanted action.
- Wired the Phase 3 voice loop to actually forward recognized speech to an attached agent
  (section 8/9's "Doggie forwards my instruction..." flow), with `doggie status` reporting the
  real attached target. Verified live against a disposable test target.
- Known gaps: no per-agent structured hooks (none of Claude Code/Kiro/Codex exposed any this
  project could integrate against from outside the process); `WrappedProcessAdapter` has no CLI
  flag yet.

## Phase 3 — 2026-11-03

- Added `services/speech-worker`: a Python process (JSON-lines over stdio, same ownership
  pattern as the Rust overlay) wrapping faster-whisper (STT, with its bundled Silero VAD) and
  Piper (TTS). Lazy-loads the whisper model on first use per the spec's performance requirements.
- Installed and verified real models: Whisper `tiny`/`base`/`small` (settled on `small` as the
  default — see TASKS.md for why `base`/`tiny` sometimes mis-script Hindi into Urdu instead of
  Devanagari, a real finding from testing, not a guess), Piper voices `en_US-norman-medium` and
  `hi_IN-pratham-medium`.
- **Deviation from the spec's stated preference, made deliberately and documented**: shipped with
  Piper as the default TTS engine instead of Kokoro, due to this machine's disk constraints
  (~3.8-5GB free during this phase) and Kokoro's own documented weak non-English support. The
  engine is behind a small interface so Kokoro can be added later without churn.
- `doggie voice setup` / `voice test` / `voice status` are real now (were stub
  "not implemented" messages after Phase 1) — install models, run a real mic→STT→TTS→playback
  round trip, and report actual installed state respectively.
- Wired a working push-to-talk loop into the live `doggie` foreground session: press Enter,
  it records, transcribes, prints the transcript (section 9's required "YOU SAID" format), and
  drives the overlay's avatar state live. Verified via `doggie status` showing `TRANSCRIBING`
  mid-turn from a second terminal.
- Found and fixed a real PyAV/faster-whisper version incompatibility (pinned `av==13.1.0`).
- Found and fixed a real timeout-too-tight bug: whisper model load under this machine's memory
  pressure (concurrently with the GPU-rendered avatar) took over 30s once, so the transcribe
  timeout is now 90s.
- Known gap: transcribed instructions aren't forwarded anywhere yet (Phase 4/5).

## Phase 2 — 2026-11-03

- Replaced the flat-circle placeholder with a real `wgpu`-rendered 3D avatar (Vulkan backend via
  the machine's Intel iGPU Mesa driver — confirmed, not assumed, by successful adapter/device
  creation and a verified rendered frame).
- Built an original procedural "canine commander" placeholder bust (sphere head, capsule
  muzzle/body, cone ears) in `native/overlay/src/mesh.rs` — not derived from any existing
  copyrighted character model.
- Implemented the full avatar animation state machine from spec section 12
  (`native/overlay/src/animation.rs`): continuous breathing/blinking, per-state head motion,
  amplitude-driven mouth, tint-based expression for Completed/Error. Controlled over the same
  stdin/control-socket channel as hide/show (`state:<NAME>`, `amp:<0..1>`).
- Added a real GLB/glTF static-mesh loader and wired `doggie avatar <path>` to persist the model
  choice and have it picked up on next launch.
- Fixed the Phase 0/1 screenshot-verification gap: `xwd` captures a window's own drawable
  directly (unlike root-based tools, which don't work under GNOME's rootless XWayland) — used
  throughout Phase 2 to visually confirm transparency, avatar shape, and each animation state
  actually renders as intended, not just "compiles and runs."
- Known gaps (see TASKS.md): no real VRM import (skeleton/blend-shapes/spring-bones), no
  GLB materials/textures.

## Phase 1 — 2026-11-03

- Monorepo scaffolded: `apps/cli` (Node/TS/Commander), `packages/shared` (types + `~/.doggie`
  paths), `native/overlay` (Rust/winit/softbuffer).
- Native overlay: transparent, frameless, draggable, always-on-top window. Always-on-top
  implemented by forcing the window through XWayland on Linux/Wayland sessions (native Wayland
  toplevels have no always-on-top protocol on GNOME) — verified via `_NET_WM_STATE_ABOVE` and
  stacking order, not just assumed. Window position persisted to `~/.doggie/position.json` and
  restored on next launch (verified by drag → stop → relaunch).
- CLI commands implemented for real: `doggie` (launch), `hide`, `show`, `stop`, `status`,
  `doctor`. Cross-terminal control via a Unix socket at `~/.doggie/run/ctl.sock`.
- `doggie doctor` performs real system checks (platform, Wayland/X11, RAM-based Whisper model
  recommendation, disk space, GPU, microphone devices, tmux, Rust toolchain, overlay binary
  presence) rather than printing a canned report.
- Lifecycle correctness verified by hand: `Ctrl+C`, `doggie stop`, and a killed overlay child all
  lead to zero stray processes and no leftover run files; double-launch is rejected with a clear
  message; a stale PID file from a crash is detected and cleaned up automatically.
- `attach`, `sessions`, `avatar`, `voice setup/test/status`, `config` are registered in the CLI
  but explicitly report "not implemented yet, lands in Phase N" rather than faking success.
- Docs: ARCHITECTURE.md (Phase 0 findings + decisions), README.md, DEVELOPMENT.md, TASKS.md
  (this file's companion).
