import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locates the compiled native overlay binary. In the monorepo dev layout it
 * lives at <repo root>/native/overlay/target/release/doggie-overlay. A
 * packaged install would ship a prebuilt binary per-platform instead
 * (tracked for Phase 6); DOGGIE_OVERLAY_BIN lets that future packaging step
 * (or a developer) override the path without touching this code.
 */
export function resolveOverlayBinary(): string {
  if (process.env.DOGGIE_OVERLAY_BIN) {
    return process.env.DOGGIE_OVERLAY_BIN;
  }

  const candidates = [
    path.resolve(__dirname, "../../../../native/overlay/target/release/doggie-overlay"),
    path.resolve(__dirname, "../../../native/overlay/target/release/doggie-overlay"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Native overlay binary not found. Build it first:\n" +
      "  cd native/overlay && cargo build --release\n" +
      "or set DOGGIE_OVERLAY_BIN to point at a prebuilt binary."
  );
}
