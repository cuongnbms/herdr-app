import type { ReactNode } from "react";

const rays = Array.from({ length: 12 }, (_, i) => i * 30);

/** Glyphs for the agents herdr detects; anything else gets a monogram. */
const GLYPHS: Record<string, { tile: string; glyph: ReactNode }> = {
  claude: {
    tile: "agent-tile-claude",
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {rays.map((r, i) => (
          <line key={r} x1="12" y1="12" x2="12" y2={i % 2 ? 4.5 : 2.5} transform={`rotate(${r} 12 12)`}
            stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
        ))}
      </svg>
    ),
  },
  codex: {
    tile: "agent-tile-dark",
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
        {[0, 60, 120].map((r) => (
          <ellipse key={r} cx="12" cy="12" rx="9" ry="4.2" transform={`rotate(${r} 12 12)`} />
        ))}
      </svg>
    ),
  },
  pi: {
    tile: "agent-tile-dark",
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <rect x="3" y="5" width="18" height="3" rx="1" />
        <rect x="6.5" y="7" width="3" height="12" rx="1" />
        <path d="M14.5 7h3v9.5c0 .8.4 1.2 1.2 1.2H20V20h-1.8c-2.4 0-3.7-1.2-3.7-3.6z" />
      </svg>
    ),
  },
  gemini: {
    tile: "agent-tile-dark",
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="gemini-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4c9aff" />
            <stop offset="1" stopColor="#b57cff" />
          </linearGradient>
        </defs>
        <path d="M12 2c.7 5.3 4.7 9.3 10 10-5.3.7-9.3 4.7-10 10-.7-5.3-4.7-9.3-10-10 5.3-.7 9.3-4.7 10-10z" fill="url(#gemini-g)" />
      </svg>
    ),
  },
  opencode: {
    tile: "agent-tile-dark",
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2">
        <rect x="5" y="4" width="14" height="16" rx="1.5" />
        <path d="M9 9h6v6H9z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
};

const TERMINAL = (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 7l5 5-5 5M12 18h7" />
  </svg>
);

export function AgentIcon({ agent }: { agent: string | null }) {
  const name = agent?.toLowerCase() ?? null;
  const known = name ? GLYPHS[name] : undefined;
  let tile = "agent-tile-dark";
  let content: ReactNode = TERMINAL;
  if (known) ({ tile, glyph: content } = known);
  else if (agent) content = <span className="agent-mono">{agent.charAt(0).toUpperCase()}</span>;
  return (
    <span className={"agent-tile " + tile} role="img" aria-label={agent ?? "no agent"}>
      {content}
    </span>
  );
}
