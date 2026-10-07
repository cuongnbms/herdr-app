import { useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import { ExternalLink, mdComponents, rehypePlugins, remarkPlugins } from "../chat/markdown";
import { resolveLink } from "./links";

export function MarkdownView({ text, rel, onOpen }: { text: string; rel: string; onOpen(rel: string): void }) {
  const root = useRef<HTMLDivElement>(null);
  const components = useMemo<Components>(
    () => ({
      ...mdComponents,
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
