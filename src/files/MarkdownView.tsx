import { useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import { ExternalLink, mdComponents, rehypePlugins, remarkPlugins } from "../chat/markdown";
import { resolveLink } from "./links";
import { makeSlugger } from "./slug";

function hastText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] } | undefined;
  if (typeof n?.value === "string") return n.value;
  return (n?.children ?? []).map(hastText).join("");
}

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

export function MarkdownView({ text, rel, onOpen }: { text: string; rel: string; onOpen(rel: string): void }) {
  const root = useRef<HTMLDivElement>(null);
  // Fresh per render pass so repeated headings get -1, -2 within this document only.
  const slug = useRef(makeSlugger());
  slug.current = makeSlugger();
  const components = useMemo<Components>(
    () => ({
      ...mdComponents,
      ...Object.fromEntries(
        HEADINGS.map((Tag) => [Tag, ({ node, children }: { node?: unknown; children?: React.ReactNode }) => <Tag id={slug.current(hastText(node))}>{children}</Tag>]),
      ),
      a({ href, children }) {
        const link = href ? resolveLink(rel, href) : null;
        if (link?.kind === "external") return <ExternalLink href={link.url}>{children}</ExternalLink>;
        if (link?.kind === "file") {
          return (
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
        }
        if (link?.kind === "anchor") {
          return (
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
        }
        return <span>{children}</span>;
      },
    }),
    [rel, onOpen],
  );
  return (
    <div className="files-markdown chat-assistant" ref={root}>
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{text}</Markdown>
    </div>
  );
}
