import fs from "node:fs";
import { POSITION_FILE, readConfig } from "@doggie/shared";
import type { DoggieRunState, AgentState } from "@doggie/shared";
import { PlainPtyAdapter, type AgentAdapter } from "@doggie/agents";
import { OverlayProcess } from "../lifecycle/overlayProcess.js";
import { startControlServer, type ControlCommand } from "../lifecycle/controlSocket.js";
import { checkRunningInstance, writeRunFiles, cleanupRunFiles, writeState } from "../lifecycle/instance.js";
import { startVoiceLoop } from "../lifecycle/voiceLoop.js";
import { startLaunchMode } from "../lifecycle/launchMode.js";
import { doggieLine, info, errorLine } from "../terminal/banner.js";

export async function runStart(launchCommand?: string): Promise<void> {
  const existing = checkRunningInstance();
  if (existing) {
    errorLine(`Doggie is already running (pid ${existing}). Use \`doggie stop\` first.`);
    process.exitCode = 1;
    return;
  }

  const config = readConfig();

  let overlay: OverlayProcess;
  try {
    overlay = new OverlayProcess();
  } catch (err) {
    errorLine((err as Error).message);
    process.exitCode = 1;
    return;
  }

  writeRunFiles(process.pid);

  let visible = true;
  let agentState: AgentState = "IDLE";
  let attached: { adapter: AgentAdapter; targetId: string; label: string } | null = null;
  const startedAt = new Date().toISOString();

  const readPosition = (): { x: number; y: number } => {
    try {
      return JSON.parse(fs.readFileSync(POSITION_FILE, "utf8"));
    } catch {
      return { x: 100, y: 100 };
    }
  };

  const currentState = (): DoggieRunState => ({
    pid: process.pid,
    startedAt,
    visible,
    position: readPosition(),
    agentState,
    attachedAgent: attached ? { targetId: attached.targetId, label: attached.label } : null,
  });

  const syncState = () => writeState(currentState());

  const applyAgentState = (next: AgentState) => {
    agentState = next;
    overlay.setState(next);
    syncState();
  };

  let voiceLoop = { stop() {} };

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    doggieLine("Shutting down...");
    voiceLoop.stop();
    if (attached) await attached.adapter.detach();
    await overlay.quit();
    cleanupRunFiles();
    server.close();
    process.exit(0);
  };

  const server = startControlServer(async (cmd: ControlCommand) => {
    if (cmd.startsWith("state:")) {
      const next = cmd.slice("state:".length) as AgentState;
      applyAgentState(next);
      return `ok: state=${next}`;
    }
    if (cmd.startsWith("amp:")) {
      const value = Number(cmd.slice("amp:".length));
      if (Number.isFinite(value)) overlay.setAmplitude(value);
      return "ok: amp";
    }
    if (cmd.startsWith("attach:")) {
      const [targetId, ...labelParts] = cmd.slice("attach:".length).split("|");
      const label = labelParts.join("|") || `pid ${targetId}`;
      if (attached) await attached.adapter.detach();
      const adapter = new PlainPtyAdapter();
      try {
        await adapter.attach(targetId);
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
      attached = { adapter, targetId, label };
      syncState();
      return `ok: attached to ${label}`;
    }
    switch (cmd) {
      case "detach":
        if (!attached) return "ok: nothing attached";
        await attached.adapter.detach();
        attached = null;
        syncState();
        return "ok: detached";
      case "hide":
        overlay.hide();
        visible = false;
        syncState();
        return "ok: hidden";
      case "show":
        overlay.show();
        visible = true;
        syncState();
        return "ok: shown";
      case "status":
        syncState();
        return JSON.stringify(currentState());
      case "stop":
        setImmediate(shutdown);
        return "ok: stopping";
      default:
        return `error: unknown command ${cmd}`;
    }
  });

  overlay.onExit((code) => {
    if (shuttingDown) return;
    errorLine(`Native overlay exited unexpectedly (code ${code}). Shutting down.`);
    cleanupRunFiles();
    server.close();
    process.exit(1);
  });

  // Crash safety: if anything throws unexpectedly after startup, still try
  // to kill the overlay child and clean up run files rather than leaving an
  // orphaned window process behind — the spec requires clean child teardown
  // even in the unhappy path, not just on Ctrl+C/`doggie stop`.
  const crashCleanup = (err: unknown) => {
    errorLine(`Unexpected error: ${err instanceof Error ? err.message : err}`);
    if (process.env.DOGGIE_DEBUG) console.error(err);
    void shutdown();
  };
  process.on("uncaughtException", crashCleanup);
  process.on("unhandledRejection", crashCleanup);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // SIGHUP: sent when the terminal Doggie is running in closes (closing the
  // window, not just Ctrl+C). Node's default disposition for SIGHUP is to
  // exit immediately with no cleanup, which would orphan the overlay child —
  // found via a real orphaned overlay process during testing, not assumed.
  process.on("SIGHUP", shutdown);

  await overlay.waitUntilReady();
  syncState();

  doggieLine("Floating avatar is online.");

  if (launchCommand) {
    info("Run `doggie stop` from another terminal, or close this one, to shut down.");
    voiceLoop = startLaunchMode(launchCommand, applyAgentState, (nextAttachment) => {
      attached = nextAttachment;
      syncState();
    });
  } else {
    info("Press Ctrl+C here, or run `doggie stop` from another terminal, to shut down.");
    voiceLoop = startVoiceLoop(applyAgentState, () =>
      attached ? { adapter: attached.adapter, label: attached.label } : null
    );
    info("Run `doggie attach` from another terminal to connect a running coding agent, or relaunch with `doggie --launch \"<command>\"` for single-terminal mode.");
  }
}
