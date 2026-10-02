import type { ReactNode } from "react";
import { TILED_MARKS, agentMark } from "./AgentMark";

const TERMINAL = (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 7l5 5-5 5M12 18h7" />
  </svg>
);

/** The agent's provider mark on a tile; unknown agents get a monogram, plain shells a prompt. */
export function AgentIcon({ agent }: { agent: string | null }) {
  const name = agent?.toLowerCase() ?? null;
  const tiled = name !== null && TILED_MARKS.has(name);
  let content: ReactNode = TERMINAL;
  if (name) content = agentMark(name, tiled ? 26 : 16) ?? <span className="agent-mono">{agent!.charAt(0).toUpperCase()}</span>;
  return (
    <span className={"agent-tile " + (tiled ? "agent-tile-bare" : "agent-tile-dark")} role="img" aria-label={agent ?? "no agent"}>
      {content}
    </span>
  );
}
