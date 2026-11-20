# Doggie — Architecture & Phase 0 Feasibility Report

## Environment this was built and tested against

- OS: Ubuntu 24.04.4 LTS, kernel 7.0.0-38-generic, x86_64
- Desktop: GNOME Shell 46.0, session type **Wayland** (`XDG_SESSION_TYPE=wayland`)
- CPU: 12 logical cores. RAM: 7.4GB total, frequently **under 1GB free** with heavy swap use from
  browser/editor processes already running. This machine is memory-constrained for local ML
  inference — see "Resource constraints" below.
- GPU: Intel UHD (iGPU) + NVIDIA RTX 3050 Mobile, but the NVIDIA driver was **not loaded**
  (`nvidia-smi` fails) at the time of testing — assume CPU-only inference as the default case.
- Disk: 92% full, ~6-7GB free on `/`. This is tight for Whisper + Kokoro model downloads.
- Toolchains present: Node 22.22, Python 3.12, gcc/build-essential, libx11-dev, libxkbcommon-dev,
  libxrandr-dev. Not present: Rust, pnpm, tmux, webkit2gtk dev headers. No passwordless sudo.

Everything below was decided from actually running things on this machine, not from
documentation alone.

## The central risk: always-on-top on GNOME/Wayland

This was called out explicitly as the highest-risk assumption, so it was tested first, before
any CLI scaffolding.

**Finding: GNOME's Wayland compositor (Mutter) has no protocol that lets an ordinary
application window request "always on top."** Unlike wlroots-based compositors (Sway, Hyprland),
GNOME does not implement `wlr-layer-shell`, and `xdg-shell` (the standard Wayland toplevel
protocol) has no always-on-top concept at all. A pure-Wayland `winit` window built with
`WindowLevel::AlwaysOnTop` compiles and runs, but the hint is silently ignored — confirmed by
building exactly such a window and observing that it's invisible to `wmctrl`/`xdotool` (which
only see X11/XWayland windows) and has no way to query or influence its stacking.

**Working solution, verified empirically:** force the overlay window through **XWayland**
instead of native Wayland (`native/overlay` unsets `WAYLAND_DISPLAY` before creating the
window, unless `DOGGIE_FORCE_WAYLAND` is set). Mutter maintains a full X11 window-management
compatibility layer for XWayland clients, and **that layer does honor `_NET_WM_STATE_ABOVE`**.
Verified with:

```
$ xprop -id <overlay window id> _NET_WM_STATE
_NET_WM_STATE(ATOM) = _NET_WM_STATE_ABOVE, _NET_WM_STATE_FOCUSED
$ xprop -root _NET_CLIENT_LIST_STACKING
_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1400005   # our window, top of stack
```

This is the same trick used in practice by long-lived Linux overlay utilities (conky, various
docks/widgets) to get always-on-top behavior under GNOME Wayland. It is a real, working
behavior on *this* desktop, not a theoretical one.

**What I could not verify:** actual pixel-level compositing (transparency, the rendered avatar
shape) by screenshot. GNOME's XWayland runs "rootless" — there is no full-desktop X11 root
pixmap to capture with ordinary X11 screenshot APIs (confirmed: a raw `XGetImage` grab of the
window's screen region came back solid black, not the rendered content). A true screenshot would
require the `xdg-desktop-portal` screencast/screenshot API, which pops a one-time user consent
dialog — not something I can click through headlessly. **You should visually confirm the overlay
looks right** (transparent background, floating above other windows, stays up when you switch
apps) the first time you run `doggie`; everything other than the pixels has been verified by me
via window-manager state.

**Portability implications (documented, not all tested):**

| Environment | Always-on-top mechanism | Status |
|---|---|---|
| GNOME / Wayland (this machine) | Force XWayland, set `_NET_WM_STATE_ABOVE` | **Tested, works** |
| Plain X11 session (any WM) | Native X11, `_NET_WM_STATE_ABOVE` directly | Should work (XWayland path *is* this path) |
| wlroots compositors (Sway, Hyprland, etc.) | Native Wayland + `wlr-layer-shell` | Not implemented yet — would need a layer-shell-aware window, a different code path from the XWayland trick. Tracked as future work. |
| KDE Plasma / Wayland | Likely needs its own always-on-top protocol extension or the XWayland trick | Not tested |
| macOS | `winit`'s `WindowLevel` maps to `NSWindow` levels (e.g. floating window level) at the API level | Not tested — no Mac available in this environment |

## Technology choices

- **CLI**: Node 22 + TypeScript + Commander, pnpm workspaces, as specified.
  - `pnpm` itself has a broken `corepack` shim in this environment (expects `bin/pnpm.cjs`,
    the fetched package only ships `bin/pnpm.mjs`) — worked around with a one-line wrapper at
    `~/.local/bin/pnpm` that invokes the `.mjs` entry directly via `node`. This is an environment
    quirk, not a project file; nothing in the repo depends on it.
- **Native overlay window**: Rust + **`winit` + `softbuffer`**, not `tao`/`wry`.
  `tao`+`wry` (the Tauri windowing/webview crates) need `webkit2gtk-4.1` dev headers, which are
  **not installed and would require `sudo apt install`** (no passwordless sudo available, and
  disk is already at 92%). `winit` + `softbuffer` has zero GTK/WebKit dependency on Linux — it
  talks to X11/Wayland directly — and built successfully with only what was already on the
  system. This keeps Phase 1 dependency-free and avoids spending scarce disk space. Phase 2
  (real 3D/VRM rendering) will need to revisit this: either an embedded `wgpu` renderer (pure
  Rust, no webview) or `wry` if webkit2gtk can be installed later. Leaning toward `wgpu` +
  `three-d`/custom glTF loading to avoid the webview dependency entirely, but this is a Phase 2
  decision, not finalized here.
- Everything else in the spec (faster-whisper, Silero VAD, Kokoro/Piper, tmux integration, VRM)
  is **not implemented yet** — Phase 1 only covers the CLI shell and the floating window.

## Resource constraints to design around (Phases 3+)

- **RAM is the binding constraint**, not CPU. This machine routinely has under 1GB free with
  heavy swap already in use before Doggie even starts. `doggie doctor` checks free RAM and
  recommends a Whisper model size accordingly (tiny/base/small/medium); on this machine right
  now it recommends **base**, and **tiny** when free memory dips further. Kokoro/Piper model
  choice should follow the same logic when Phase 3 is built.
- **Disk is the second constraint** (~6-7GB free, 92% full). Whisper + Kokoro model weights need
  to be downloaded lazily (per spec) and the user should be warned by `doctor` if there isn't
  enough headroom — not yet implemented, tracked in TASKS.md.
- **No GPU acceleration available right now** (driver not loaded) — CPU inference is the correct
  default, not just a fallback.

## Process/lifecycle model

- `doggie` (no args) is a **foreground** process — the terminal you launch it from is the one
  that stays attached to it (this matches the spec's "Doggie's terminal is the primary
  conversation console"). It is not a background daemon and does not install itself as a
  service: run `doggie`, it runs until you `Ctrl+C` it or run `doggie stop` from elsewhere.
- It spawns exactly one child: the native overlay binary (`native/overlay`), over a piped stdin
  it owns, and treats itself as responsible for that child's lifecycle: SIGINT/SIGTERM and
  `doggie stop` all drive the same clean-shutdown path (ask the child to quit over its stdin,
  wait up to 2s, SIGKILL as a last resort, remove its own PID/socket/state files). If the
  overlay child dies unexpectedly, the parent notices and shuts itself down rather than running
  headless.
- Cross-invocation commands (`doggie hide` / `show` / `stop` / `status`, run from a second
  terminal) talk to the running foreground process over a Unix domain socket at
  `~/.doggie/run/ctl.sock`. This is process-to-process IPC scoped to one user's one running
  instance, not a persistent daemon or network listener.
- Window position is persisted to `~/.doggie/position.json` by the Rust overlay itself (on drag
  release and on quit) and read back on the next launch. Verified: drag the window, stop
  Doggie, relaunch — it reopens at the last position.

## Phase 2 update: GPU rendering

The overlay now renders real 3D content via `wgpu`, confirmed using the machine's **Intel iGPU
over Vulkan** (`adapter.get_info()` reports `Intel(R) Graphics (ADL GT2), IntegratedGpu, Vulkan`)
— not a software rasterizer fallback, despite the discrete NVIDIA GPU's driver not being loaded.
This matters for the resource-constraint picture in Phase 0: 3D rendering is hardware
accelerated and does not compete with Whisper/Kokoro for CPU or RAM.

Alpha transparency and correct per-pixel content were verified with real screenshots (not just
window-manager state) — see "Screenshot verification" in TASKS.md for how, since the earlier
`mss` approach doesn't work under GNOME's rootless XWayland.

## Phase 3: voice stack decisions

- **STT**: faster-whisper (ctranslate2 backend — no PyTorch dependency, which matters given this
  machine's disk headroom). Default model is **`small`**, not `tiny`/`base`, because testing
  found the smaller models sometimes transcribe real Hindi speech into **Urdu/Perso-Arabic
  script** instead of Devanagari — a genuine, verified failure mode, not a hypothetical one. VAD
  is faster-whisper's bundled Silero VAD (`vad_filter=True`), so no separate VAD integration was
  needed.
- **TTS**: **Piper**, not Kokoro, is the installed default — a deliberate deviation from the
  spec's stated preference, made because disk was already constrained (~3.8-5GB free) and
  Kokoro's own community documents weak non-English quality. Piper's Hindi (`hi_IN-pratham`) and
  English (`en_US-norman`, a deep narrator voice) were both verified working by generating real
  audio and round-tripping it through whisper. The engine sits behind a small interface so Kokoro
  can be added later.
- **Resource contention, found not assumed**: a cold whisper model load competing with the
  always-on 30fps `wgpu` avatar render loop took over 30 seconds once on this RAM-constrained,
  actively-swapping machine. Client timeouts were tuned accordingly (90s for transcribe calls)
  rather than assuming a desktop-class machine's timing.
- **Terminal integration**: push-to-talk is "press Enter in Doggie's terminal," not the spec's
  global Ctrl+Space shortcut — a real, working stand-in; true OS-level global hotkeys are
  tracked for Phase 6, since they need a different mechanism per platform/desktop environment.

## Phase 4: plain-terminal attachment (tmux deprioritized by user request)

Asked the user directly rather than assuming: this machine has no passwordless sudo (can't
`apt-get install tmux`), and a prebuilt static tmux binary from a third-party project was found
but correctly blocked by the coding harness from being executed unverified. The user's answer:
they run their coding agents in a plain terminal, not tmux. So effort went into a real
plain-terminal attachment path instead of a tmux adapter nobody here would use or could verify.

**Mechanism**: an already-running terminal program reads its input from its controlling PTY's
*slave* device node (e.g. `/dev/pts/3`). Any process with write permission on that device node —
not just the terminal emulator — can write bytes into it, and the reading program receives them
exactly as if typed. This is the same generic mechanism tools like `expect`/`pexpect` use; it has
nothing to do with tmux specifically.

**I verified this before writing any adapter code**, because "should work in theory" isn't the
same as tested: spawned a disposable `cat` on a freshly-created pty with the pty's ECHO flag
explicitly turned off (so kernel-level input echo couldn't be mistaken for real delivery),
wrote into the slave device path from a separate, unrelated process, and confirmed `cat` actually
read and re-emitted it. Then verified the real `PlainPtyAdapter` class the same way.

**What this can and can't do, honestly:**
- Input: yes, best-effort. Submitting a line of text + Enter should work for most interactive
  CLIs. Rich raw-mode TUI behavior (bracketed paste, complex escape sequences) isn't guaranteed
  to match real keystrokes perfectly.
- Output: no. A plain terminal keeps no scrollback another process can read after the fact —
  only tmux, or wrapping the process from launch, gives you that. `observeOutput()` is a
  documented no-op here, and `getStatus()` never invents progress it can't actually observe.
- Detection works against real processes (tested against this project's own live Claude Code
  session and the user's real Kiro session), but attaching was only ever tested against
  disposable, throwaway target processes — never the user's actual live session, since using
  their real session as a test subject would itself be an unwanted, irreversible action.

**Fallback for full read+write**: `WrappedProcessAdapter` launches the agent itself inside a
real PTY via `node-pty` (compiled cleanly, no new system packages needed), giving genuine
bidirectional control at the cost of being a new session rather than an existing one. Built and
verified; not yet wired to a CLI flag.

## What's next

See TASKS.md for the phase-by-phase backlog. The next open engineering question is full VRM
import (skeleton/blend-shapes/spring-bones) — deliberately deferred; what's built so far loads
static GLB/glTF geometry only.
