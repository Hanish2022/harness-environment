# Doggie

A terminal-launched, voice-controlled animated AI desktop companion that sits alongside your
existing coding CLI agents (Claude Code, Kiro, Codex, etc.) — a floating 2D sprite pet, local
speech-to-text/text-to-speech with no cloud APIs or subscriptions, and (best-effort) control of
an agent running in another terminal.

**Status:** all 6 phases from the original spec have a working implementation, tested by hand
against real system state throughout (window-manager properties, real screenshots, real
mic/TTS round-trips, real process injection — see ARCHITECTURE.md and TASKS.md for exactly what
was verified and how). Several things are deliberately simplified or left for later and are
called out below and in TASKS.md rather than hidden.

## Quick start

```bash
./scripts/install.sh     # builds everything, links `doggie` onto your PATH
doggie doctor            # checks your machine (RAM, disk, GPU, mic, display server, tmux...)
doggie voice setup       # downloads the local STT/TTS stack (~150MB: faster-whisper + Piper)
doggie                   # launches the floating avatar (this terminal becomes Doggie's console)
```

From another terminal, while `doggie` is running:

```bash
doggie status            # pid, visibility, position, attached agent
doggie sessions          # detect running Claude Code / Kiro / Codex processes
doggie attach <pid>      # connect one (asks for confirmation first)
doggie hide / doggie show
doggie stop              # clean shutdown
```

In Doggie's own terminal: press **Enter**, then speak. It records, transcribes, classifies what
you said, and (if an agent is attached) forwards instructions, reports status, or interrupts
execution — see "What works" below for exactly what that does and doesn't do yet.

## What works (verified, not assumed)

- **Floating avatar**: transparent, frameless, draggable, always-on-top, defaults to the
  bottom-right corner of the screen, position persists across restarts. A real `wgpu`-rendered
  2D sprite pet (a `codex-pets`-format spritesheet, bundled at build time), with per-state
  frame-cycling animation (idle, listening, thinking, executing, waiting, completed, error,
  interrupted each map to a row of the sheet).
- **Local voice**: faster-whisper (STT, with its bundled Silero VAD) + Piper (TTS) — fully
  offline after the one-time model download, no API keys, no subscriptions. Verified for both
  English and Hindi by generating real audio and round-tripping it through transcription.
  Language auto-detection can be unreliable on a real mic (confirmed on real hardware, not just
  synthetic clips) — force it with `doggie voice lang <auto|en|hi>` if it keeps mislabeling.
- **Optional cloud STT**: `doggie voice provider gemini` (needs your own `GEMINI_API_KEY`, opt-in
  only, local stays default). Claude's API has no audio input capability, so there's no Claude
  equivalent to offer.
- **Agent attachment**: `doggie sessions` detects real running Claude Code/Kiro/Codex processes.
  `doggie attach` connects by writing directly into the target's PTY (works without tmux) —
  input only, best-effort; it cannot read a plain terminal's output after the fact (no tmux, no
  wrapping = no scrollback to capture). A full read+write "launch inside Doggie" fallback
  (`WrappedProcessAdapter`, via `node-pty`) exists and is verified but not yet wired to a CLI flag.
- **Orchestration**: deterministic (no LLM) intent classification — instruction vs. question vs.
  "stop/cancel" vs. general conversation — unit-tested against the spec's own worked examples.
- **Packaging**: `scripts/install.sh` / `uninstall.sh` / `package-linux.sh` are real and tested,
  including from a from-scratch minimal environment and a freshly extracted package tarball.

## What's simplified or missing (see TASKS.md for the full, honest list)

- Push-to-talk is "press Enter, records 4 seconds" — not press-and-hold, and not the spec's
  global Ctrl+Space hotkey (needs OS-level registration, not built).
- No tmux adapter — the user of this build runs agents in a plain terminal, not tmux, so effort
  went into the PTY-injection path instead (see ARCHITECTURE.md for why and how it was verified).
- Kokoro TTS isn't installed by default (Piper is) — a disk-constraint + unverified-language-
  quality tradeoff made explicit in ARCHITECTURE.md, not a silent downgrade.
- `doggie config` is unimplemented. macOS was never tested (no Mac available) — winit/node-pty/
  faster-whisper/Piper all claim macOS support upstream, but none of it was exercised here.

## Setup (manual, if you don't want to use install.sh)

```bash
pnpm install
pnpm --filter @doggie/shared --filter @doggie/voice --filter @doggie/agents --filter @doggie/orchestrator --filter @doggie/cli build
(cd native/overlay && cargo build --release)
ln -sf "$(pwd)/apps/cli/dist/index.js" ~/.local/bin/doggie
```

Requires Node 22+, Rust (stable), Python 3. See DEVELOPMENT.md for a known `pnpm`/corepack issue
and its workaround (`install.sh` already handles it).

## Project layout

```
apps/cli/            Node/TypeScript CLI (Commander)
packages/shared/      Types + ~/.doggie/* paths + config
packages/voice/       Speech worker client, mic capture, playback, setup
packages/agents/      AgentAdapter interface + plain-PTY / wrapped-process adapters
packages/orchestrator/ Deterministic intent classifier (+ real unit tests)
native/overlay/       Rust (winit + wgpu) floating 2D sprite window
services/speech-worker/ Python process: faster-whisper (STT) + Piper (TTS)
scripts/              install.sh, uninstall.sh, package-linux.sh
```

ARCHITECTURE.md, DEVELOPMENT.md, TASKS.md and CHANGELOG.md go phase-by-phase into what was
built, what was verified and how, and what's left.

## Platform notes

- **Linux**: built and tested on GNOME 46 / Wayland (Ubuntu 24.04). Always-on-top is achieved by
  routing the overlay through XWayland (Mutter has no Wayland-native always-on-top protocol) —
  empirically verified, see ARCHITECTURE.md. wlroots compositors (Sway/Hyprland) would need a
  different, not-yet-implemented `wlr-layer-shell` code path.
- **macOS**: not tested — no Mac available in this environment. Cross-platform APIs used
  throughout (winit, node-pty, faster-whisper, Piper) all claim macOS support upstream.
