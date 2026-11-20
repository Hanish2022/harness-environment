import { detectPlainSessions } from "@doggie/agents";
import { info, warn } from "../terminal/banner.js";

export async function runSessions(): Promise<void> {
  const sessions = detectPlainSessions();
  if (sessions.length === 0) {
    info("No running Claude Code / Kiro / Codex processes with a real terminal were found.");
    info("Start one in a normal terminal (not piped/backgrounded) and run `doggie sessions` again.");
    return;
  }
  info(`Found ${sessions.length} candidate session(s):`);
  for (const s of sessions) {
    console.log(`  ${s.id}  ${s.label}`);
  }
  warn(
    "Plain-terminal attachment can send input (best-effort) but cannot observe output — " +
      "there's no capturable scrollback outside tmux. See ARCHITECTURE.md Phase 4."
  );
  info("Run `doggie attach <pid>` to connect one.");
}
