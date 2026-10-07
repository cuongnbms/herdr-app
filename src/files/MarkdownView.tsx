import { useLayoutEffect, useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import { ExternalLink, InLinkContext, mdComponents, nodeText, rehypePlugins, remarkPlugins } from "../chat/markdown";
import { resolveLink } from "./links";
import { makeSlugger } from "./slug";
import { useScrollMemory } from "./TextView";

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Sets a GitHub-style slug `id` on h1-h6; one fresh slugger per run, so re-renders cannot shift ids. */
function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = makeSlugger();
    const walk = (n: HastNode) => {
      if (n.tagName && /^h[1-6]$/.test(n.tagName)) n.properties = { ...n.properties, id: slug(nodeText(n)) };
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

const viewRehypePlugins = [...(rehypePlugins as unknown as unknown[]), rehypeHeadingIds] as never;

const byId = (root: HTMLElement | null, id: string) => root?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;

interface Props {
  text: string;
  rel: string;
  /** Opens a linked file; `hash` is its decoded `#fragment`, if any. */
  onOpen(rel: string, hash: string | null): void;
  initialScroll: number;
  /** A heading to show instead of the remembered position (a `doc.md#section` link). */
  initialHash?: string | null;
  saveScroll(path: string, top: number): void;
}

/** One mount per file, so scroll memory pairs with the right file. */
export function MarkdownView(props: Props) {
  return <RenderedMarkdown key={props.rel} {...props} />;
}

function RenderedMarkdown({ text, rel, onOpen, initialScroll, initialHash, saveScroll }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(rel, initialScroll, saveScroll);
  // react-markdown renders synchronously, so the content is laid out here.
  useLayoutEffect(() => {
    const target = initialHash ? byId(root.current, initialHash) : null;
    if (target) target.scrollIntoView?.();
    else if (root.current) root.current.scrollTop = initialScroll;
  }, []);
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
                onOpen(link.rel, link.hash);
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
                byId(root.current, link.hash)?.scrollIntoView();
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
    <div className="files-markdown chat-assistant" ref={root} onScroll={onScroll}>
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={viewRehypePlugins} components={components}>{text}</Markdown>
    </div>
  );
}
