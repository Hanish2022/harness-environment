# Tasks

## Phase 0 — Technical feasibility — DONE

- [x] Inspect OS/arch/RAM/GPU/audio/display server/WM
- [x] Determine always-on-top strategy for GNOME/Wayland (XWayland + `_NET_WM_STATE_ABOVE`,
      verified via `xprop`/`wmctrl`)
- [x] Pick native windowing stack (`winit` + `softbuffer`, not `tao`/`wry` — avoids needing
      `webkit2gtk` dev headers that would require `sudo apt install` on a disk-constrained,
      no-passwordless-sudo machine)
- [x] Write up findings — see ARCHITECTURE.md

## Phase 1 — CLI and floating avatar — DONE

- [x] `doggie` CLI (Commander), builds to `apps/cli/dist/index.js`, linked as `doggie` on PATH
- [x] Native transparent, frameless, draggable, always-on-top overlay window (`native/overlay`)
- [x] Position persistence across restarts (verified: drag → stop → relaunch reopens at same spot)
- [x] Clean shutdown: `Ctrl+C`, `doggie stop` from another terminal, and a crashed/killed overlay
      child all lead to no stray processes and no leftover `~/.doggie/run/*` files (all verified)
- [x] Cross-process control: `doggie hide` / `show` / `status` / `stop` via Unix socket
- [x] `doggie doctor`: real checks (platform, display server, RAM → recommended Whisper model
      size, disk space, GPU, microphone via `arecord -l`, tmux presence, Rust toolchain, overlay
      binary presence)
- [x] Stale-instance detection (dead PID cleans up old run files instead of refusing to start)
- [x] Unimplemented commands (`attach`, `sessions`, `avatar`, `voice *`, `config`) say so plainly
      instead of pretending to succeed

## Phase 2 — Character rendering — MOSTLY DONE

- [x] Rendering approach decided and built: `wgpu` (Vulkan backend, confirmed using the Intel
      iGPU's Mesa ICD on this machine) + a hand-rolled WGSL shader, no webview. Verified the
      transparent/alpha-blended output is real (not just window-manager state) via `xwd` +
      a small custom XWD→PNG parser (see "Screenshot verification" below) — corner pixel reads
      alpha=0, avatar pixels read the expected RGB.
- [x] Original placeholder "canine commander" bust built procedurally from primitives (sphere
      head, capsule muzzle/body, cone ears, sphere eyes/nose, cuboid mouth) in
      `native/overlay/src/mesh.rs` — not a scrape of any existing character.
- [x] Procedural animation state machine (`native/overlay/src/animation.rs`) implementing the
      full state table from spec section 12 (Idle/Listening/Transcribing/Thinking/Speaking/
      Executing/Waiting/Completed/Error/Interrupted): head rotation per state, continuous
      breathing + randomized blinking, mouth-open driven by amplitude, color tint for
      Completed/Error. Driven over the same stdin channel as hide/show (`state:<NAME>`,
      `amp:<0..1>`), and from the Node CLI through the existing control socket — verified by
      screenshotting SPEAKING (mouth visibly opens with amp:0.9), ERROR (visible pink tint +
      downward head tilt), and THINKING (visible head yaw) and confirming each looks distinct.
- [x] GLB/glTF static-geometry loader (`mesh::load_glb_static`, via the `gltf` crate) — verified
      against a hand-built minimal GLB fixture (a tetrahedron with no normals/indices-optional
      path), confirmed it renders. `doggie avatar <path.glb>` persists the model path to
      `~/.doggie/config.json`; `doggie` picks it up on next launch — verified end to end.
- [ ] **Not done**: real VRM import (humanoid bone retargeting, spring-bone physics, blend-shape
      expression groups) — a GLB/glTF loaded this way is static geometry with the idle head-sway
      applied rigidly to the whole mesh, no skeleton. This is the single biggest remaining gap
      in Phase 2 and is a substantial separate project in its own right (full VRM 0.x/1.0
      support). Tracked, not attempted here given time budget — flagging honestly rather than
      claiming VRM support that doesn't exist.
- [ ] Textures/materials from the GLB are not read (flat-shaded single color only).

### Screenshot verification (fixed the Phase 0/1 gap)

Phase 0/1 found that `mss`/raw X11 root capture doesn't work under GNOME's rootless XWayland
(solid black). Phase 2 fixed this: `xwd -id <window id>` captures a *specific window's* own
drawable directly rather than the (nonexistent) composited root pixmap, and does work. A small
Python parser (`scratchpad/xwd2png.py` during development) converts the XWD dump to a normal
PNG. This is now the standing way to visually verify anything rendered in the overlay.

## Phase 3 — Local voice — MOSTLY DONE

- [x] Microphone capture via `arecord` (ALSA, already present on this machine — real capture
      device confirmed via `arecord -l`: `sof-hda-dsp`). `packages/voice/src/mic.ts`.
- [x] faster-whisper STT, with its bundled Silero VAD (`vad_filter=True`) enabled to skip
      silence rather than transcribing dead air — this covers the spec's VAD requirement without
      a separate integration, since faster-whisper ships Silero VAD internally.
- [x] Hindi/English transcription verified in a closed loop (Piper TTS → faster-whisper STT,
      since I can't physically speak into the mic myself): English transcribed correctly;
      Hindi detected correctly as `hi` with real audio. **Real finding, not assumed:** the
      `tiny`/`base` whisper models sometimes render Hindi speech in **Urdu/Perso-Arabic script**
      instead of Devanagari (e.g. "मैं फाइलें पढ़ रहा हूं" came back as "میں پیلی بڑھ رہا ہوں" with
      `base`) — `small` reliably produced correct Devanagari output. Default model is now
      **`small`** for this reason (see `recommendWhisperModel()`), not `base` as Phase 0/1
      guessed before this was actually tested.
- [x] TTS: **Piper**, not Kokoro, is the installed default — a deliberate, documented deviation.
      Reasoning: disk was already down to ~3.8-5GB free by the time Phase 3 started; Kokoro's
      non-English language quality is explicitly flagged by its own community as weak
      ("non-English languages may be absent or thin due to weak G2P and/or lack of training
      data" per Replicate's model docs); Piper officially lists Hindi (`hi_IN`) and I verified
      it actually works for both English (`en_US-norman-medium`, a deep narrator-style voice
      matching the "commander" personality brief) and Hindi (`hi_IN-pratham-medium`) by
      generating real audio and feeding it back through whisper. The TTS engine is behind a
      small interface (`speak(text, lang, outPath)`) so Kokoro can be added later without
      touching callers — see "Optional future cloud/engine support" in the top-level spec.
- [x] `doggie voice setup` — really downloads/installs faster-whisper (pinned with
      `av==13.1.0`, see below), the Piper binary, and the two default voices; idempotent (skips
      what's already present). `doggie voice test` — really records from the mic, transcribes,
      and speaks+plays a reply. `doggie voice status` — really reports what's installed. None
      of these are stubs anymore.
- [x] Live terminal integration (spec section 9): the foreground `doggie` process now has a
      working push-to-talk loop — press Enter in Doggie's own terminal, it records, transcribes,
      and prints the exact transcription with the required "🎤 YOU SAID" formatting, and drives
      the overlay's avatar state (LISTENING → TRANSCRIBING → IDLE) live, verified via
      `doggie status` mid-turn. **Simplification, documented honestly:** this is fixed-duration
      (4s) recording per Enter press, not true press-and-hold push-to-talk, and the Ctrl+Space
      *global* hotkey from spec section 13 needs OS-level hotkey registration (tracked for
      Phase 6) — Enter-in-terminal is the real, working stand-in for now.
- [ ] **Not done**: forwarding the transcribed instruction anywhere — that's Phase 4 (attach to
      an agent) and Phase 5 (decide what to do with it). Phase 3 prints the transcript and stops
      there, honestly, rather than pretending to act on it.
- [ ] Disk-space-aware warning in `doctor`/`voice setup` before downloading models — not added;
      disk usage is reported by `doctor` but setup doesn't yet refuse to run on a full disk.

### Post-Phase-3 addition: optional cloud STT (Gemini)

After real-world testing exposed low-confidence, sometimes-wrong language auto-detection on an
actual microphone (not the clean synthetic test clips), the user asked whether Claude or Gemini
could be used for transcription instead. Investigated rather than assumed:

- **Claude's API has no audio input capability at all** — Messages API accepts text and images
  only. There's no "send Claude audio, get text back" to build against, regardless of effort.
- **Gemini's API does support audio input**, so this was added as a genuinely optional provider
  (`doggie voice provider gemini`), opt-in only — local Whisper stays the default, per the
  original spec's "no mandatory cloud APIs" constraint. The API key is **never written to
  `~/.doggie/config.json`** — read only from `GEMINI_API_KEY` at call time, so it's never
  persisted or logged.
- **Had to verify Google's current API shape rather than trust training knowledge**: this
  project's knowledge of the Gemini API predates real changes (model names have moved well past
  what's recognized from training — current flash models are in the `gemini-3.x` range as of this
  writing, and Google's docs also describe a newer "Interactions API" alongside the long-standing
  `generateContent` REST method). Built against `generateContent` specifically because its
  request/response shape could be cross-confirmed from multiple current doc pages, while the
  newer Interactions API's response shape couldn't be confirmed from what was available — picked
  the one that could actually be verified, not the newest-looking one.
- **Verified for real, without a live API key**: called the real endpoint with a syntactically
  valid request and a deliberately invalid key — Google's server responded with a clean
  `API_KEY_INVALID` error rather than a malformed-request error, which is strong evidence the
  endpoint, model name, and request body shape are all correct. Could not verify actual
  transcription quality/accuracy without the user's own real key.
- Falls back to local Whisper (loudly, with a warning — never silently) if `gemini` is selected
  but no key is present, rather than failing the whole turn.

### Real resource-contention finding (not hidden)

The very first live end-to-end test timed out: whisper `small` model load, running while the
`wgpu`-rendered overlay was also active, took **over 30 seconds** on this RAM-constrained machine
(sub-1GB free, actively swapping) — my original 30s client timeout was too tight for a cold model
load under real memory pressure here. Fixed by raising the transcribe timeout to 90s (model load
is a one-time cost per worker process; later calls are fast). A second run completed in ~11s,
confirming this is contention/variance under pressure, not a hang. Documented rather than quietly
papered over, since it's a real signal about this phase's actual resource envelope on this
machine.

### Dependency pin worth remembering

`faster-whisper` 1.2.1's bundled audio decode calls PyAV with a `metadata_errors` kwarg that
was removed from PyAV's current release (19.x) at the time this was built — hit a hard
`TypeError` on every transcribe call until pinned to `av==13.1.0`. `runVoiceSetup()` installs
this pin automatically.

## Phase 4 — CLI integration — MOSTLY DONE (plain-terminal path; tmux deprioritized)

- [x] **tmux decision**: asked the user directly rather than guessing. There's no passwordless
      sudo on this machine, so I couldn't `apt-get install tmux` myself; I also found a prebuilt
      static tmux binary from a third-party GitHub project, but the harness itself blocked me
      from executing an unverified downloaded binary (correctly — that's a real supply-chain
      question, not mine to wave through). Asked the user; they said **they run their agents in
      a plain terminal, not tmux**. So the tmux adapter (spec's integration mechanism #1) is
      *not implemented* — building and "verifying" it without tmux installed or in actual use
      would just be unverified code. The `AgentAdapter` interface is tmux-shaped-compatible if
      someone adds it later.
- [x] `AgentAdapter` interface (`packages/agents/src/types.ts`) matching the spec's TypeScript
      interface exactly (`detectSessions`, `attach`, `sendInstruction`, `observeOutput`,
      `interrupt`, `getStatus`, `detach`).
- [x] **Plain-terminal adapter** (`PlainPtyAdapter`) — mechanism #3/4 from the spec's priority
      list ("shell integration" / "terminal integrations"), implemented as direct PTY-slave-device
      writes, which is how `expect`/`pexpect`-style tools inject input without tmux. **Verified
      the mechanism itself** before writing any adapter code: spawned a disposable `cat` process
      on its own freshly-created pty with terminal echo explicitly turned *off* (to rule out
      mistaking passive kernel echo for real delivery), wrote into the slave device path from an
      unrelated process, and confirmed `cat` genuinely read and echoed it back. Then verified the
      actual `PlainPtyAdapter` TypeScript class the same way (attach → sendInstruction →
      confirmed delivery via the disposable target's captured output).
- [x] **Detection, tested against real running processes** (not mocks): `doggie sessions` on
      this machine found and correctly labeled the actual live Claude Code session this project
      was being built in, and the user's real Kiro CLI session, by scanning `ps` for known
      process names with a real controlling tty.
  - **Honest, explicit limitation**: `observeOutput()` is a documented no-op for this adapter.
    A plain already-running terminal keeps no scrollback another process can read — only tmux
    (or wrapping the process from launch) can do that. `getStatus()` never fabricates progress;
    it says plainly that output can't be observed.
  - **Never tested against a real live agent session** — sending synthetic keystrokes into the
    user's actual Claude Code or Kiro session to "prove it works" would itself be an unwanted,
    consequential action. All sendInstruction/interrupt testing used disposable throwaway
    processes created for testing only.
  - Safety: `doggie attach` requires interactive y/n confirmation before attaching (spec's
    "require confirmation for dangerous operations"), only offers pids `doggie sessions` itself
    detected (not arbitrary pids), and `PlainPtyAdapter` re-verifies the target pid is still
    alive and still owns the same tty before every write (guards against PID reuse).
- [x] **Wrapped-process fallback** (mechanism #5, "explicit launch-inside-Doggie"): built on
      `node-pty`, which compiled and linked successfully on this machine (python3/gcc already
      present, no new system packages needed). Gives genuine full-duplex control — real
      `sendInstruction` *and* real `observeOutput` — unlike the plain-terminal path. Verified by
      launching a disposable `bash` under it, sending a command, and confirming the actual output
      came back through `observeOutput`. Exposed as `WrappedProcessAdapter`; not yet wired to a
      CLI flag (`doggie attach --launch "<cmd>"`) — the class is ready, the CLI surface for it
      isn't built yet.
- [x] Live wiring: the Phase 3 voice loop now actually forwards recognized speech to an attached
      agent via `sendInstruction`, printing the section 9-required "Sending instruction to
      X... Instruction delivered." lines, and `doggie status` reports the real attached
      target — verified live (attach a disposable target over the real control socket while a
      real `doggie` instance is running, confirm `doggie status` reflects it).
- [ ] **Not done**: per-adapter Claude Code/Kiro/Codex-specific hooks. None of the three expose
      documented structured lifecycle hooks this project could integrate against from outside the
      process in this session — the generic process-name-based detection + PTY injection is the
      common denominator that actually works today, which is what's built.
- [x] **`doggie --launch "<cmd>"` single-terminal mode** — added after real usage friction: the
      two-terminal `doggie`/`doggie attach` flow worked but was annoying for routine use. This
      wraps the target command (e.g. `kiro-cli-chat`) in `WrappedProcessAdapter`'s real PTY,
      mirrors its output directly into Doggie's own terminal, and forwards keystrokes to it —
      so it looks and behaves like you just ran that command normally, with the avatar floating
      alongside. **Ctrl+T** (not the spec's suggested Ctrl+Space — that's sent inconsistently
      across terminal emulators, some send a NUL byte, some nothing; Ctrl+T arrives as one
      unambiguous byte, which matters since this scans raw bytes rather than parsing escape
      sequences) triggers a voice turn instead of typing; everything else passes straight
      through. Verified for real, not just written and assumed: input forwarding (typed text
      round-tripped through a wrapped `cat`), the Ctrl+T trigger correctly splits surrounding
      text so nothing typed in the same keystroke burst gets silently dropped, and — the
      important one — **Ctrl+C correctly interrupts the wrapped session without killing Doggie
      itself** (ran `sleep 30` in a wrapped bash, Ctrl+C'd it, then ran another command
      successfully in the same session, confirming it survived and Doggie's own process stayed
      up throughout).

## Phase 5 — Orchestration — MOSTLY DONE

- [x] Deterministic, keyword/pattern-based intent classifier (`packages/orchestrator`), no LLM
      API — classifies INSTRUCTION / QUESTION / AGENT_CONTROL / GENERAL across English, Hindi
      (Devanagari) and Hinglish. **Genuinely unit-tested**, not just eyeballed: `node --test`
      against 6 test cases including the spec's own section-10 worked examples verbatim
      ("Payment service analyse karo." → INSTRUCTION, "Doggie, kya progress hai?" → QUESTION,
      "Stop execution." → AGENT_CONTROL, "Claude ne kya changes kiye?" → QUESTION, "Abhi koi
      command execute mat karna." → AGENT_CONTROL) — all pass. Every classification reports
      which rule matched, so a wrong call is debuggable, not a black box.
- [x] Wired into the live voice loop: each transcribed turn is now classified and branches for
      real — AGENT_CONTROL calls `adapter.interrupt()`, QUESTION calls `adapter.getStatus()` and
      speaks the (honestly limited) result, INSTRUCTION calls `adapter.sendInstruction()`,
      GENERAL just replies. Each branch speaks a short Piper reply in the detected language.
      Verified: the classifier import resolves and produces correct output when run inside the
      actual CLI's dependency tree (not just in the orchestrator package's own tests), and the
      control-socket/attach plumbing underneath it was already live-verified in Phase 4.
      **Not separately live-tested as one continuous spoken turn** (would need audio actually
      reaching the mic input, which isn't acoustically possible to arrange for an agent without
      a real mouth/speaker loopback in this environment) — composed from independently-verified
      pieces (real transcription, real classification, real adapter calls) rather than one
      unverified assembly.
- [x] Progress state machine: `AgentState` (`packages/shared/src/types.ts`) now also includes
      `SPEAKING` (the avatar animation table in spec section 12 distinguishes it from agent
      progress states, which the original Phase 1 type didn't have room for) and is driven live
      by both the voice loop and the attached adapter's `getStatus()`.
- [ ] **Not done**: using `WrappedProcessAdapter`'s real `observeOutput()` stream to infer
      TOOL_RUNNING/WAITING_FOR_APPROVAL automatically — current status inference is a crude
      idle-time heuristic (see `wrappedAdapter.ts`), and it isn't wired to a CLI command yet
      regardless (see Phase 4's `--launch` gap).

## Phase 6 — Production readiness — MOSTLY DONE (Linux only; macOS untestable here)

- [x] `scripts/install.sh` — real, tested build-and-link script. Verified from a fully minimal
      environment (`env -i` with only `node`/`cargo` on PATH, no pnpm, no prior wrapper) that it
      correctly detects the broken corepack `pnpm` shim (same bug noted in Phase 0/DEVELOPMENT.md),
      works around it, builds every package, builds the Rust overlay, and links a working
      `doggie` command — confirmed with a full `doggie` → `status` → `stop` cycle afterward.
- [x] `scripts/uninstall.sh` — tested both plain (`./uninstall.sh`) and `--purge` (also removes
      `~/.doggie`) modes; refuses to run while Doggie is still active.
- [x] `scripts/package-linux.sh` — builds a real, tested redistributable tarball (33MB).
      Deliberately **excludes** the Python venv / downloaded Whisper models / Piper voices
      (~1.3GB on this machine) — those are meant to be fetched on-demand by `doggie voice setup`
      after install, like any tool that lazy-loads ML models, not duplicated into every package
      build. Verified by extracting the tarball to a clean directory and running its bundled
      `install.sh` with Rust completely absent from PATH, then launching the result end-to-end
      (overlay comes up, `doggie status` reports correctly, `doggie stop` shuts down cleanly).
  - **Real bug found and fixed by this test**: `install.sh`'s repo-root detection assumed it
    always lives at `<repo>/scripts/install.sh`, which broke once `package-linux.sh` copied it to
    the package root instead — fixed by detecting which layout is actually present rather than
    assuming one.
- [x] Error-handling pass: `index.ts` now catches rejected command actions and prints a clean
      one-line error (full stack only with `DOGGIE_DEBUG=1`) instead of a raw Node crash dump.
      `start.ts` additionally catches `uncaughtException`/`unhandledRejection` *after* startup
      and routes them through the same clean-shutdown path used by Ctrl+C/`doggie stop`,
      specifically so a bug doesn't leave the overlay child orphaned (the spec requires clean
      child teardown even in the unhappy path).
- [x] Freed ~745MB of Rust incremental-build cache (`cargo clean`, keeping the built binary) once
      Rust development was done, given this machine's persistently tight disk — worth knowing if
      continuing Rust work later (a full rebuild from clean takes ~2 minutes on this machine).
- [ ] `doggie config` — still an honest "not implemented" stub; no terminal-UI config editor was
      built (voice/avatar config already has real, if narrower, commands: `doggie voice setup`,
      `doggie avatar <path>`).
- [ ] **macOS packaging/verification — not done, no Mac available in this environment.**
      `winit`'s cross-platform window-level API should map to an appropriate `NSWindow` level,
      and `node-pty`/faster-whisper/Piper all have macOS builds upstream, but none of this was
      exercised on real macOS hardware. Flagged honestly rather than assumed.
- [x] Automated tests exist and actually run: `packages/orchestrator`'s classifier tests
      (`node --test`, 6 cases including the spec's own worked examples). Everything else in this
      project was verified by hand against real system state (window-manager properties, actual
      screenshots, real mic/TTS round-trips, real process injection) because the thing being
      tested is OS/hardware-level behavior that a unit test can't meaningfully stand in for —
      documented per-phase in this file and in ARCHITECTURE.md, not silently skipped.
- [ ] **Known rough edge, not fixed**: `doggie <unrecognized-subcommand>` currently falls through
      to launching the default `start` command instead of printing a clean "unknown command"
      error, because Commander's `isDefault` feature treats any unmatched argument as an argument
      *to* the default command by design. Found via this phase's own regression pass. Not fixed
      here — correctly disabling it needs restructuring the top-level command routing, which felt
      too risky to rush at the end of a long session rather than a quick, safe patch.
