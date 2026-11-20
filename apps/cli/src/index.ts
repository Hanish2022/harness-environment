#!/usr/bin/env node
import { Command } from "commander";
import { runStart } from "./commands/start.js";
import { runHide, runShow, runStop, runStatus } from "./commands/remote.js";
import { runDoctor } from "./commands/doctor.js";
import { runVoiceSetupCmd, runVoiceStatusCmd, runVoiceTestCmd, runVoiceLangCmd, runVoiceProviderCmd } from "./commands/voice.js";
import { runSessions } from "./commands/sessions.js";
import { runAttach } from "./commands/attach.js";
import { notImplemented } from "./terminal/banner.js";

const program = new Command();

program
  .name("doggie")
  .description("Floating animated AI companion for terminal-based coding agents")
  .version("0.1.0");

program
  .command("start", { isDefault: true, hidden: true })
  .option("--launch <command>", "Launch a coding agent command wrapped in this same terminal (single-terminal mode, e.g. --launch \"kiro-cli-chat\")")
  .action((opts) => runStart(opts.launch));

program.command("hide").description("Hide the floating avatar").action(runHide);
program.command("show").description("Show the floating avatar").action(runShow);
program.command("stop").description("Shut down Doggie cleanly").action(runStop);
program.command("status").description("Display current avatar, voice and agent status").action(runStatus);
program.command("doctor").description("Check dependencies, permissions, models, audio devices and platform capabilities").action(runDoctor);

program.command("attach [pid]").description("Attach to an existing supported CLI session").action(runAttach);
program.command("sessions").description("List detectable sessions").action(runSessions);
const voice = program.command("voice").description("Voice configuration and diagnostics");
voice.command("setup").description("Install/download the local STT+TTS stack").action(runVoiceSetupCmd);
voice.command("test").description("Record, transcribe, and speak a reply").action(runVoiceTestCmd);
voice.command("status").description("Show voice stack status").action(runVoiceStatusCmd);
voice
  .command("lang [code]")
  .description("Force STT language (auto|en|hi) instead of relying on auto-detection")
  .action(runVoiceLangCmd);
voice
  .command("provider [name]")
  .description("Choose STT provider: local (default, offline) or gemini (cloud, opt-in, needs GEMINI_API_KEY)")
  .action(runVoiceProviderCmd);
program.command("config").description("Open terminal-based configuration").action(() => notImplemented("doggie config", "Phase 6"));

program.parseAsync(process.argv).catch((err) => {
  console.error(`❌ Unexpected error: ${err instanceof Error ? err.message : err}`);
  if (process.env.DOGGIE_DEBUG) console.error(err);
  else console.error("(set DOGGIE_DEBUG=1 for the full stack trace)");
  process.exit(1);
});
