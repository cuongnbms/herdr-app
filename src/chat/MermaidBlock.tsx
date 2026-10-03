import { useEffect, useId, useState, type ReactNode } from "react";
import { useTheme } from "../settings/theme";

/** Wait this long after the last change before rendering, so a streaming reply does not re-render per token. */
const RENDER_DELAY_MS = 150;

/** Mermaid is large; load it the first time a diagram shows up, not at startup. */
let loader: Promise<typeof import("mermaid").default> | null = null;
const loadMermaid = () => (loader ??= import("mermaid").then((m) => m.default));

/**
 * A ```mermaid fence drawn as a diagram. Until the source parses (mid-stream, or just wrong) or if
 * rendering fails, it shows the highlighted source like any other code block.
 */
export function MermaidBlock({ source, children }: { source: string; children: ReactNode }) {
  const theme = useTheme((s) => s.theme);
  const id = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", dompurifyConfig: { FORBID_TAGS: ["img"] }, suppressErrorRendering: true, theme: theme === "dark" ? "dark" : "default" });
        if (cancelled || !(await mermaid.parse(source, { suppressErrors: true }))) return;
        const out = await mermaid.render(id, source);
        if (!cancelled) setSvg(out.svg);
      } catch (err) {
        console.warn("mermaid render failed", err);
        if (!cancelled) setSvg(null);
      }
    }, RENDER_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, theme, id]);

  const diagram = svg !== null && !showSource;
  return (
    <div className="chat-code chat-mermaid">
      <div className="chat-code-head">
        mermaid
        {svg !== null && (
          <button type="button" className="chat-mermaid-toggle" onClick={() => setShowSource(!showSource)}>
            {showSource ? "Diagram" : "Source"}
          </button>
        )}
      </div>
      {diagram ? <div className="chat-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre>{children}</pre>}
    </div>
  );
}
