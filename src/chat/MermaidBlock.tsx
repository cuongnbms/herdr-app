import { useEffect, useId, useState, type ReactNode } from "react";
import { useTheme } from "../settings/theme";

/** Wait this long after the last change before rendering, so a streaming reply does not re-render per token. */
const RENDER_DELAY_MS = 150;

/** Mermaid is large; load it the first time a diagram shows up, not at startup. */
let loader: Promise<typeof import("mermaid").default> | null = null;
const loadMermaid = () => (loader ??= import("mermaid").then((m) => m.default));

/** Drop every SVG <image>: mermaid's final sanitize ignores dompurifyConfig, and the WebView would fetch the href. */
function stripImages(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    const html = new DOMParser().parseFromString(svg, "text/html");
    html.querySelectorAll("image").forEach((el) => el.remove());
    return html.body.innerHTML;
  }
  doc.querySelectorAll("image").forEach((el) => el.remove());
  return new XMLSerializer().serializeToString(doc.documentElement);
}

const CACHE_MAX = 50;
/** Rendered SVGs by theme and source, so a row that scrolls out and back in shows its diagram at once, at the same height. */
const svgCache = new Map<string, string>();
const cacheKey = (theme: string, source: string) => `${theme}\n${source}`;

export function clearMermaidCache(): void {
  svgCache.clear();
}

function cacheGet(key: string): string | undefined {
  const hit = svgCache.get(key);
  if (hit !== undefined) {
    // Re-insert to mark it most recently used.
    svgCache.delete(key);
    svgCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, svg: string): void {
  svgCache.delete(key);
  svgCache.set(key, svg);
  if (svgCache.size > CACHE_MAX) svgCache.delete(svgCache.keys().next().value!);
}

/**
 * A ```mermaid fence drawn as a diagram. Until the source parses (mid-stream, or just wrong) or if
 * rendering fails, it shows the highlighted source like any other code block.
 */
export function MermaidBlock({ source, children }: { source: string; children: ReactNode }) {
  const theme = useTheme((s) => s.theme);
  const id = "mmd" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(() => cacheGet(cacheKey(theme, source)) ?? null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    const key = cacheKey(theme, source);
    const cached = cacheGet(key);
    if (cached !== undefined) {
      setSvg(cached);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        // dompurifyConfig replaces mermaid's default label config ({ FORBID_TAGS: ["style"] }) rather
        // than extending it, so "style" must stay listed: a label <style> would restyle the whole app.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", dompurifyConfig: { FORBID_TAGS: ["img", "style"] }, suppressErrorRendering: true, theme: theme === "dark" ? "dark" : "default" });
        if (cancelled || !(await mermaid.parse(source, { suppressErrors: true }))) return;
        const out = await mermaid.render(id, source);
        const clean = stripImages(out.svg);
        cacheSet(key, clean);
        if (!cancelled) setSvg(clean);
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
