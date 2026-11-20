#!/usr/bin/env bash
# Builds Doggie and links the `doggie` command onto PATH. Real build steps,
# not a placeholder — this is what Phase 1-6 of this project were actually
# tested with throughout development.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Dev checkout: this file lives at <repo>/scripts/install.sh, so the repo
# root is one level up. Packaged tarball (scripts/package-linux.sh): this
# file is copied to the package root directly, so HERE *is* the root.
if [ -f "$HERE/apps/cli/package.json" ]; then
  REPO_ROOT="$HERE"
else
  REPO_ROOT="$(cd "$HERE/.." && pwd)"
fi
BIN_DIR="${DOGGIE_INSTALL_BIN_DIR:-$HOME/.local/bin}"

# package-linux.sh drops this marker in a staged tarball so a target machine
# installing from a prebuilt package doesn't need Rust/pnpm to rebuild
# everything from source — a plain dev checkout never has this file, so
# re-running install.sh after editing code still does a full rebuild.
PREBUILT=false
[ -f "$REPO_ROOT/.doggie-prebuilt" ] && PREBUILT=true

echo "==> Checking prerequisites"
command -v node >/dev/null || { echo "Node.js is required (v22+). Install it first."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required for the speech worker (voice is optional, but setup needs it)."; exit 1; }
if [ "$PREBUILT" = false ]; then
  command -v cargo >/dev/null || { echo "Rust (cargo) is required to build the overlay from source. Install via https://rustup.rs then re-run. (Not needed when installing from a package built by scripts/package-linux.sh — this is a source checkout.)"; exit 1; }
fi

if ! command -v pnpm >/dev/null || ! pnpm --version >/dev/null 2>&1; then
  echo "==> pnpm missing or broken on PATH (e.g. a corepack shim pointing at bin/pnpm.cjs when" \
       "only bin/pnpm.mjs exists — a real issue hit during this project's own development) —" \
       "checking for a corepack-downloaded copy to wrap directly"
  COREPACK_PNPM=$(find "$HOME/.cache/node/corepack" -name "pnpm.mjs" 2>/dev/null | head -1)
  if [ -n "$COREPACK_PNPM" ]; then
    mkdir -p "$BIN_DIR"
    cat > "$BIN_DIR/pnpm" << EOF
#!/usr/bin/env bash
exec node "$COREPACK_PNPM" "\$@"
EOF
    chmod +x "$BIN_DIR/pnpm"
    export PATH="$BIN_DIR:$PATH"
    echo "    wrote a pnpm wrapper to $BIN_DIR/pnpm (see DEVELOPMENT.md: corepack's pnpm.cjs lookup is broken upstream as of this writing)"
  else
    echo "pnpm not found and no corepack cache to wrap. Install pnpm (npm install -g pnpm) and re-run."
    exit 1
  fi
fi

if [ "$PREBUILT" = true ]; then
  echo "==> Prebuilt package detected (.doggie-prebuilt) — skipping install/build steps"
else
  echo "==> Installing JS dependencies"
  cd "$REPO_ROOT"
  pnpm install

  echo "==> Building TypeScript packages"
  pnpm --filter @doggie/shared build
  pnpm --filter @doggie/voice build
  pnpm --filter @doggie/agents build
  pnpm --filter @doggie/orchestrator build
  pnpm --filter @doggie/cli build

  echo "==> Building native overlay (Rust)"
  (cd "$REPO_ROOT/native/overlay" && cargo build --release)
fi

echo "==> Linking doggie into $BIN_DIR"
mkdir -p "$BIN_DIR"
chmod +x "$REPO_ROOT/apps/cli/dist/index.js"
ln -sf "$REPO_ROOT/apps/cli/dist/index.js" "$BIN_DIR/doggie"

echo ""
echo "Done. Make sure $BIN_DIR is on your PATH, then run:"
echo "  doggie doctor      # check your machine"
echo "  doggie voice setup # download the local STT/TTS models (~150MB)"
echo "  doggie             # launch it"
