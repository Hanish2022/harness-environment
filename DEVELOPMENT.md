# Development

## Prerequisites

- Node 22+, pnpm (see note below if `corepack`/`pnpm` is broken in your environment)
- Rust stable (`rustup`)
- Linux: `libx11-dev`, `libxkbcommon-dev`, `libxrandr-dev`, `build-essential` (all on by default
  on most desktop distros; these are what `winit` needs to build on Linux)

### `pnpm` via a broken `corepack`

On this machine, `corepack prepare pnpm@latest --activate` downloaded pnpm's files but then
failed to find `bin/pnpm.cjs` (the installed pnpm ships only `bin/pnpm.mjs`). If you hit the same
thing, skip corepack and invoke the downloaded `.mjs` directly, e.g. a tiny wrapper script on
`PATH`:

```bash
#!/usr/bin/env bash
exec node "$HOME/.cache/node/corepack/v1/pnpm/<version>/bin/pnpm.mjs" "$@"
```

Or just `npm install -g pnpm` on a machine where that isn't broken.

## Build

```bash
pnpm install
pnpm --filter @doggie/shared build
pnpm --filter @doggie/voice build
pnpm --filter @doggie/agents build
pnpm --filter @doggie/orchestrator build
pnpm --filter @doggie/cli build
(cd native/overlay && cargo build --release)
```

Or just run `./scripts/install.sh`, which does all of the above (and links `doggie` onto PATH).

`apps/cli` resolves the native binary at
`native/overlay/target/release/doggie-overlay` relative to its own compiled location; override
with `DOGGIE_OVERLAY_BIN=/path/to/binary` if you've built it elsewhere (packaging will need this
for prebuilt per-platform binaries — Phase 6).

## Running from source without reinstalling the symlink

```bash
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js        # launches it
```

or `pnpm --filter @doggie/cli dev` (uses `tsx`, no build step, but still needs the Rust binary
built separately).

## Runtime files

Everything lives under `~/.doggie/` (override with `DOGGIE_HOME`):

- `~/.doggie/run/doggie.pid` — PID of the running foreground `doggie` process
- `~/.doggie/run/ctl.sock` — Unix socket for `hide`/`show`/`status`/`stop` from other terminals
- `~/.doggie/run/state.json` — last-synced run state (read by `doggie status`)
- `~/.doggie/position.json` — persisted overlay window position, written by the Rust binary

If `doggie` crashes without cleaning up, the next `doggie` invocation detects the stale PID (via
`process.kill(pid, 0)`) and removes the leftover run files automatically.

## Testing the overlay in isolation

The Rust binary understands newline-delimited commands on stdin: `hide`, `show`, `quit`,
`state:<AgentState>` (e.g. `state:SPEAKING`), `amp:<0..1>` (lip-sync amplitude). Useful for manual
testing without the Node CLI:

```bash
mkfifo /tmp/doggie-stdin
./native/overlay/target/release/doggie-overlay < /tmp/doggie-stdin &
exec 3>/tmp/doggie-stdin
echo hide >&3
echo show >&3
echo state:THINKING >&3
echo quit >&3
```

On a GNOME/Wayland session you can confirm always-on-top state with:

```bash
wmctrl -l | grep doggie
xprop -id $(xdotool search --name '^doggie$') _NET_WM_STATE
```

You should see `_NET_WM_STATE_ABOVE` in the output.

**Actual visual verification** (not just window-manager state): `mss`/root-based X11 screenshot
tools don't work under GNOME's rootless XWayland (comes back solid black). `xwd -id <window id>
-out shot.xwd` captures a specific window's own drawable directly and does work; convert it with
a small XWD→PNG parser (plain Python, ~30 lines: read the fixed 25-word big-endian header, skip
the window name + any colormap entries, decode the raw BGRA bytes with Pillow). This is how every
rendering claim in this project (transparency, the avatar's actual shape, each animation state)
was actually confirmed, not just assumed from the code compiling and running.

## Testing the speech worker in isolation

```bash
cd services/speech-worker
mkfifo /tmp/worker-stdin
.venv/bin/python worker.py < /tmp/worker-stdin &
exec 3>/tmp/worker-stdin
echo '{"id":1,"cmd":"speak","text":"hello","lang":"en","out_path":"/tmp/out.wav"}' >&3
echo '{"id":2,"cmd":"transcribe","audio_path":"/tmp/out.wav"}' >&3
```

Known dependency pin: `faster-whisper` 1.2.x's bundled PyAV call uses a kwarg (`metadata_errors`)
that current PyAV (19.x) removed — pin `av==13.1.0` (`runVoiceSetup()` does this automatically).

## Testing agent attachment safely

`PlainPtyAdapter` writes directly into a target process's controlling PTY slave device — verify
the mechanism with a disposable target, never a real session, since injecting into your own live
Claude Code session to "test" it is itself a destructive action:

```bash
python3 -c "
import os, pty, subprocess, fcntl, termios
m, s = pty.openpty()
def ctty():
    os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
p = subprocess.Popen(['cat'], stdin=s, stdout=s, stderr=s, preexec_fn=ctty, close_fds=True)
print('pid', p.pid)
input()  # keep alive; write to the printed tty path from another shell to test
"
```

## Running the orchestrator's tests

```bash
pnpm --filter @doggie/orchestrator build
cd packages/orchestrator && node --test dist/__tests__/
```

## Known rough edges (current, across all phases — see TASKS.md for the full per-phase list)

- `doggie status`'s reported avatar position can be one drag-move stale: the overlay only writes
  `position.json` on drag-release or on quit, not continuously while dragging. Harmless.
- `doggie <unrecognized-subcommand>` falls through to launching the default `start` action
  instead of erroring, a side effect of Commander's `isDefault` routing. Not fixed — see TASKS.md.
- GLB/glTF loading is static geometry only (no skeleton, no morph targets, no VRM extensions).
- `PlainPtyAdapter.observeOutput()` is a deliberate no-op (see ARCHITECTURE.md Phase 4) — don't
  expect it to report real agent output outside the `WrappedProcessAdapter` fallback.
- Most of this project was verified by hand against real system state (window-manager
  properties, real screenshots, real mic/TTS audio, real PTY injection) rather than unit tests,
  because the thing being tested is OS/hardware-level behavior a unit test can't stand in for.
  `packages/orchestrator` is the exception — its classifier has real `node --test` coverage.
