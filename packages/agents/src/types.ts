import type { AgentState } from "@doggie/shared";

export interface AgentSession {
  id: string;
  kind: "tmux" | "plain-pty" | "wrapped";
  label: string;
  /** What this session actually supports — set expectations, don't overclaim. */
  capabilities: {
    canSendInstruction: boolean;
    canObserveOutput: boolean;
    canInterrupt: boolean;
  };
}

export interface AgentStatus {
  state: AgentState;
  /** Human-readable detail, or null when this adapter genuinely can't tell. */
  detail: string | null;
}

/** Mirrors the spec's AgentAdapter interface (section 8) exactly. */
export interface AgentAdapter {
  detectSessions(): Promise<AgentSession[]>;
  attach(sessionId: string): Promise<void>;
  sendInstruction(text: string): Promise<void>;
  observeOutput(onData: (chunk: string) => void): void;
  interrupt(): Promise<void>;
  getStatus(): Promise<AgentStatus>;
  detach(): Promise<void>;
}
