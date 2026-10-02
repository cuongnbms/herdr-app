import type { AgentStatus } from "../lib/types";

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`dot dot-${status}`} role="img" aria-label={"status " + status} />;
}
