import os from "node:os";
import path from "node:path";

export const DOGGIE_HOME =
  process.env.DOGGIE_HOME ?? path.join(os.homedir(), ".doggie");

export const RUN_DIR = path.join(DOGGIE_HOME, "run");
export const PID_FILE = path.join(RUN_DIR, "doggie.pid");
export const SOCKET_FILE = path.join(RUN_DIR, "ctl.sock");
export const POSITION_FILE = path.join(DOGGIE_HOME, "position.json");
export const CONFIG_FILE = path.join(DOGGIE_HOME, "config.json");
export const STATE_FILE = path.join(RUN_DIR, "state.json");
export const TRANSCRIPT_LOG = path.join(DOGGIE_HOME, "transcripts.log");
