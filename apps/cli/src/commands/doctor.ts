import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { resolveOverlayBinary } from "../lifecycle/overlayBinary.js";
import { recommendWhisperModel } from "@doggie/voice";

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function which(bin: string): boolean {
  return tryExec(`command -v ${bin}`) !== null;
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];
  const platform = os.platform();

  checks.push({ label: "Platform", ok: true, detail: `${platform} ${os.release()} (${os.arch()})` });

  if (platform === "linux") {
    const sessionType = process.env.XDG_SESSION_TYPE ?? "unknown";
    const desktop = process.env.XDG_CURRENT_DESKTOP ?? "unknown";
    checks.push({
      label: "Display server",
      ok: true,
      detail: `${sessionType} (${desktop})${
        sessionType === "wayland" ? " — always-on-top uses the XWayland fallback, see ARCHITECTURE.md" : ""
      }`,
    });
    const hasWmctrl = which("wmctrl");
    const hasXdotool = which("xdotool");
    checks.push({
      label: "X11 tooling (wmctrl/xdotool)",
      ok: hasWmctrl && hasXdotool,
      detail: hasWmctrl && hasXdotool ? "present" : "missing — only needed for diagnostics, not required at runtime",
    });
  } else if (platform === "darwin") {
    checks.push({ label: "Display server", ok: true, detail: "macOS native windowing (not exercised on this machine)" });
  }

  const totalMemGB = os.totalmem() / 1024 ** 3;
  const freeMemGB = os.freemem() / 1024 ** 3;
  checks.push({
    label: "RAM",
    ok: freeMemGB > 1,
    detail: `${freeMemGB.toFixed(1)}GB free / ${totalMemGB.toFixed(1)}GB total — recommended Whisper model: ${recommendWhisperModel()}`,
  });

  const df = tryExec(`df -h "${os.homedir()}" | tail -1`);
  if (df) {
    const parts = df.split(/\s+/);
    const avail = parts[3] ?? "?";
    const usePct = parts[4] ?? "?";
    const availGB = parseFloat(avail);
    checks.push({
      label: "Disk space (home)",
      ok: !avail.includes("G") || availGB > 2,
      detail: `${avail} available (${usePct} used)`,
    });
  }

  const gpu = tryExec("nvidia-smi --query-gpu=name --format=csv,noheader") ?? tryExec("lspci | grep -i vga");
  checks.push({
    label: "GPU",
    ok: true,
    detail: gpu ? gpu : "none detected — voice models will run CPU-only",
  });

  if (platform === "linux") {
    const mics = tryExec("arecord -l");
    checks.push({
      label: "Microphone input",
      ok: !!mics && mics.includes("card"),
      detail: mics && mics.includes("card") ? mics.split("\n")[0] : "no capture devices found via arecord -l",
    });
  }

  checks.push({ label: "tmux", ok: which("tmux"), detail: which("tmux") ? "installed" : "not installed — required for Phase 4 CLI session attachment" });
  checks.push({ label: "Rust toolchain", ok: which("cargo") || fs.existsSync(`${os.homedir()}/.cargo/bin/cargo`), detail: "needed to build the native overlay" });

  try {
    const bin = resolveOverlayBinary();
    checks.push({ label: "Native overlay binary", ok: true, detail: bin });
  } catch (err) {
    checks.push({ label: "Native overlay binary", ok: false, detail: (err as Error).message.split("\n")[0] });
  }

  checks.push({ label: "Node.js", ok: true, detail: process.version });

  console.log("\u{1F415} DOGGIE DOCTOR\n");
  for (const c of checks) {
    const mark = c.ok ? "✅" : "⚠️ ";
    console.log(`${mark} ${c.label}: ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(
    failed.length === 0
      ? "\nAll checks passed."
      : `\n${failed.length} item(s) need attention before full functionality is available.`
  );
}
