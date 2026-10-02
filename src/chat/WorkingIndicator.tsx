import type { AgentStatus } from "../lib/types";

// Sits between the transcript and the composer, outside the virtualized list, so it
// stays at the bottom without disturbing row measurement.
export function WorkingIndicator({ status }: { status: AgentStatus }) {
  if (status !== "working") return null;
  return (
    <div className="chat-working" role="status">
      <span className="chat-working-dots" aria-hidden="true"><i /><i /><i /></span>
      Working…
    </div>
  );
}
