// Mirrors the Rust structs in src-tauri field-for-field (snake_case). Filled in by later tasks.

export interface PaneRef {
  machine_id: string;
  session: string;
  pane_id: string;
}

export interface AppError {
  code: string;
  message: string;
}

export function paneKey(ref: PaneRef): string {
  return `${ref.machine_id}/${ref.session}/${ref.pane_id}`;
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type MachineState =
  | "disconnected"
  | "authenticating"
  | "probing"
  | "connected"
  | "incompatible"
  | "error";

export interface PaneView {
  pane_id: string;
  terminal_id: string;
  title: string;
  cwd: string | null;
  agent: string | null;
  status: AgentStatus;
}

export interface TabView {
  tab_id: string;
  label: string;
  number: number;
  status: AgentStatus;
  panes: PaneView[];
}

export interface WorkspaceView {
  workspace_id: string;
  label: string;
  number: number;
  status: AgentStatus;
  tabs: TabView[];
}

export interface SessionView {
  name: string;
  running: boolean;
  status: AgentStatus;
  error: AppError | null;
  workspaces: WorkspaceView[];
}

export interface MachineView {
  id: string;
  label: string;
  /** "local" or "ssh" */
  kind: string;
  state: MachineState;
  error: AppError | null;
  version: string | null;
  status: AgentStatus;
  sessions: SessionView[];
}

export interface PaneStatusEvent {
  pane: PaneRef;
  status: AgentStatus;
  previous: AgentStatus;
  title: string;
}

export type AttachEvent =
  | { type: "attached" }
  | { type: "held" }
  | { type: "exited"; code: number | null }
  | { type: "detached" };

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant_text"; markdown: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input_summary: string; input: unknown }
  | { kind: "tool_result"; call_id: string; output: string; is_error: boolean }
  | { kind: "system"; text: string };

export type ChatEvent =
  | { type: "reset"; items: ChatItem[]; total: number }
  | { type: "append"; items: ChatItem[] }
  | { type: "error"; error: AppError };

export interface Located {
  agent: string;
  path: string;
  ambiguous: boolean;
  candidates: string[];
}

export type QuotaProvider = "claude" | "codex" | "opencodeGo" | "grok";
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  durationSecs: number | null;
}
export type QuotaOutcome =
  | { kind: "ok"; windows: QuotaWindow[]; fetchedAt: number }
  | { kind: "notSignedIn" }
  | { kind: "signInExpired" }
  | { kind: "noSubscription" }
  | { kind: "rateLimited"; until: number }
  | { kind: "failed"; reason: string };
