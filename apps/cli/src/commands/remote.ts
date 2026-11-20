import { sendControlCommand } from "../lifecycle/controlSocket.js";
import { checkRunningInstance } from "../lifecycle/instance.js";
import { doggieLine, errorLine, info } from "../terminal/banner.js";

async function withRunningInstance(action: (pid: number) => Promise<void>): Promise<void> {
  const pid = checkRunningInstance();
  if (!pid) {
    errorLine("Doggie is not running. Start it with `doggie`.");
    process.exitCode = 1;
    return;
  }
  await action(pid);
}

export async function runHide(): Promise<void> {
  await withRunningInstance(async () => {
    const reply = await sendControlCommand("hide");
    if (reply.startsWith("ok")) doggieLine("Avatar hidden.");
    else errorLine(reply);
  });
}

export async function runShow(): Promise<void> {
  await withRunningInstance(async () => {
    const reply = await sendControlCommand("show");
    if (reply.startsWith("ok")) doggieLine("Avatar visible.");
    else errorLine(reply);
  });
}

export async function runStop(): Promise<void> {
  await withRunningInstance(async (pid) => {
    const reply = await sendControlCommand("stop");
    if (reply.startsWith("ok")) doggieLine(`Stop signal sent (pid ${pid}).`);
    else errorLine(reply);
  });
}

export async function runStatus(): Promise<void> {
  await withRunningInstance(async () => {
    const reply = await sendControlCommand("status");
    const state = JSON.parse(reply);
    const uptimeSec = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000);
    info(`pid:        ${state.pid}`);
    info(`uptime:     ${uptimeSec}s`);
    info(`visible:    ${state.visible}`);
    info(`position:   x=${state.position.x} y=${state.position.y}`);
    info(`agentState: ${state.agentState}`);
    info("voice:      press Enter in Doggie's own terminal to talk (see `doggie voice status`)");
    info(`agent:      ${state.attachedAgent ? state.attachedAgent.label : "not attached (see \`doggie attach\`)"}`);
  });
}
