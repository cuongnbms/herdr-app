import type { AgentStatus } from "../lib/types";

// Sits between the transcript and the composer, outside the virtualized list, so it
// stays at the bottom without disturbing row measurement. The row keeps its height when
// the agent is not working, so the transcript and composer do not jump as it comes and goes.
export function WorkingIndicator({ status }: { status: AgentStatus }) {
  return (
    <div className="chat-working">
      {status === "working" && (
        <span className="chat-working-label" role="status">
          <span className="chat-working-dots" aria-hidden="true"><i /><i /><i /></span>
          Working…
        </span>
      )}
    </div>
  );
}
