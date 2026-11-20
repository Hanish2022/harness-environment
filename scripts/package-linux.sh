#!/usr/bin/env bash
# Builds a redistributable tarball for Linux. Deliberately does NOT bundle
# the Python venv, downloaded Whisper models, or Piper voices (that's ~1.3GB
# on this machine) — those are fetched on demand by `doggie voice setup`
# after install, same as any other tool that lazy-loads ML models. Bundling
# them would make the package enormous for no benefit (they're re-downloaded
# per-platform/per-model-size choice anyway).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/dist-package}"
STAGE="$OUT_DIR/doggie"

echo "==> Building (reuses install.sh's build steps)"
"$REPO_ROOT/scripts/install.sh" >/dev/null

echo "==> Staging package at $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

cp -r "$REPO_ROOT/apps" "$STAGE/apps"
cp -r "$REPO_ROOT/packages" "$STAGE/packages"
cp -r "$REPO_ROOT/node_modules" "$STAGE/node_modules"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-workspace.yaml" "$STAGE/"

mkdir -p "$STAGE/native/overlay/target/release"
cp "$REPO_ROOT/native/overlay/target/release/doggie-overlay" "$STAGE/native/overlay/target/release/doggie-overlay"

mkdir -p "$STAGE/services/speech-worker"
cp "$REPO_ROOT/services/speech-worker/worker.py" "$STAGE/services/speech-worker/worker.py"
# voices/, bin/piper, .venv/ are intentionally excluded — `doggie voice setup` creates them.

cp "$REPO_ROOT/README.md" "$REPO_ROOT/ARCHITECTURE.md" "$STAGE/"
cp "$REPO_ROOT/scripts/install.sh" "$REPO_ROOT/scripts/uninstall.sh" "$STAGE/"
touch "$STAGE/.doggie-prebuilt"

# Strip dev-only node_modules weight where safe (TS source for packages
# whose dist/ is already staged — their compiled output is all that's needed
# at runtime).
find "$STAGE/node_modules" -maxdepth 1 -name "typescript" -exec rm -rf {} + 2>/dev/null || true

echo "==> Archiving"
TARBALL="$OUT_DIR/doggie-linux-x86_64.tar.gz"
tar -czf "$TARBALL" -C "$OUT_DIR" doggie
SIZE=$(du -h "$TARBALL" | cut -f1)

echo ""
echo "Package: $TARBALL ($SIZE)"
echo "Install on a target machine with: tar -xzf doggie-linux-x86_64.tar.gz && cd doggie && ./install.sh"
echo "(needs Node 22+ and python3 on the target; no Rust toolchain needed since the overlay binary is prebuilt)"
