import { useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import { ExternalLink, InLinkContext, mdComponents, rehypePlugins, remarkPlugins } from "../chat/markdown";
import { resolveLink } from "./links";
import { makeSlugger } from "./slug";

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastText(node: HastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(hastText).join("");
}

/** Sets a GitHub-style slug `id` on h1-h6; one fresh slugger per run, so re-renders cannot shift ids. */
function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = makeSlugger();
    const walk = (n: HastNode) => {
      if (n.tagName && /^h[1-6]$/.test(n.tagName)) n.properties = { ...n.properties, id: slug(hastText(n)) };
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

const viewRehypePlugins = [...(rehypePlugins as unknown as unknown[]), rehypeHeadingIds] as never;

export function MarkdownView({ text, rel, onOpen }: { text: string; rel: string; onOpen(rel: string): void }) {
  const root = useRef<HTMLDivElement>(null);
  const components = useMemo<Components>(
    () => ({
      ...mdComponents,
      a({ href, children }) {
        const link = href ? resolveLink(rel, href) : null;
        let inner;
        if (link?.kind === "external") inner = <ExternalLink href={link.url}>{children}</ExternalLink>;
        else if (link?.kind === "file") {
          inner = (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                onOpen(link.rel);
              }}
            >
              {children}
            </a>
          );
        } else if (link?.kind === "anchor") {
          inner = (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                root.current?.querySelector(`[id="${CSS.escape(link.hash)}"]`)?.scrollIntoView();
              }}
            >
              {children}
            </a>
          );
        } else inner = <span>{children}</span>;
        return <InLinkContext.Provider value={true}>{inner}</InLinkContext.Provider>;
      },
    }),
    [rel, onOpen],
  );
  return (
    <div className="files-markdown chat-assistant" ref={root}>
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={viewRehypePlugins} components={components}>{text}</Markdown>
    </div>
  );
}
