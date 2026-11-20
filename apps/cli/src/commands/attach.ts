import readline from "node:readline";
import { detectPlainSessions } from "@doggie/agents";
import { sendControlCommand } from "../lifecycle/controlSocket.js";
import { checkRunningInstance } from "../lifecycle/instance.js";
import { doggieLine, errorLine, info, warn } from "../terminal/banner.js";

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export async function runAttach(pid?: string): Promise<void> {
  if (!checkRunningInstance()) {
    errorLine("Doggie is not running. Start it with `doggie` first.");
    process.exitCode = 1;
    return;
  }

  const sessions = detectPlainSessions();
  let target = sessions.find((s) => s.id === pid);

  if (!pid) {
    if (sessions.length === 0) {
      errorLine("No candidate sessions found. Run `doggie sessions` for details.");
      return;
    }
    if (sessions.length > 1) {
      info("Multiple candidates found — run `doggie attach <pid>`:");
      for (const s of sessions) console.log(`  ${s.id}  ${s.label}`);
      return;
    }
    target = sessions[0];
  }

  if (!target) {
    errorLine(`pid ${pid} is not a detected Claude Code / Kiro / Codex session. Run \`doggie sessions\` to see candidates.`);
    process.exitCode = 1;
    return;
  }

  warn(
    "Attaching lets Doggie write input into this terminal on your behalf (best-effort — it " +
      "cannot read the terminal's output). Only do this for a session you own and expect to drive this way."
  );
  const ok = await confirm(`Attach to ${target.label}?`);
  if (!ok) {
    info("Cancelled.");
    return;
  }

  const reply = await sendControlCommand(`attach:${target.id}|${target.label}`);
  if (reply.startsWith("ok")) doggieLine(reply.slice(4));
  else errorLine(reply);
}
