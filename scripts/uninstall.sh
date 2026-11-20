#!/usr/bin/env bash
# Reverses install.sh. By default only removes the `doggie` command itself
# (build artifacts and the repo are left alone — this project is still a
# source checkout, not something with a separate package-manager record to
# remove). Pass --purge to also delete ~/.doggie (position/config/models are
# NOT touched by --purge if they live under a custom DOGGIE_HOME; it only
# removes the default location).
set -euo pipefail

BIN_DIR="${DOGGIE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
DOGGIE_HOME="${DOGGIE_HOME:-$HOME/.doggie}"

if pgrep -f "apps/cli/dist/index.js" >/dev/null 2>&1; then
  echo "Doggie appears to be running. Run 'doggie stop' first, then re-run this script."
  exit 1
fi

if [ -L "$BIN_DIR/doggie" ] || [ -f "$BIN_DIR/doggie" ]; then
  rm -f "$BIN_DIR/doggie"
  echo "Removed $BIN_DIR/doggie"
else
  echo "No doggie command found at $BIN_DIR/doggie (already removed, or installed elsewhere)"
fi

if [ "${1:-}" = "--purge" ]; then
  if [ -d "$DOGGIE_HOME" ]; then
    rm -rf "$DOGGIE_HOME"
    echo "Removed $DOGGIE_HOME (position, config, run state)"
  fi
  echo "Note: downloaded voice models under services/speech-worker/ are NOT removed by --purge"
  echo "(they live in the source checkout, not \$DOGGIE_HOME) — delete that directory yourself if you want them gone."
else
  echo "Left $DOGGIE_HOME in place (your avatar position/config). Pass --purge to remove it too."
fi
