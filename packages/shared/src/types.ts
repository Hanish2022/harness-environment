export type AgentState =
  | "IDLE"
  | "LISTENING"
  | "TRANSCRIBING"
  | "THINKING"
  | "SENDING_INSTRUCTION"
  | "SPEAKING" // avatar animation table (spec section 12) distinguishes this from agent progress
  | "EXECUTING"
  | "TOOL_RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_INPUT"
  | "COMPLETED"
  | "ERROR"
  | "INTERRUPTED";

export interface DoggieRunState {
  pid: number;
  startedAt: string;
  visible: boolean;
  position: { x: number; y: number };
  agentState: AgentState;
  attachedAgent: { targetId: string; label: string } | null;
}
