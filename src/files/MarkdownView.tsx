import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { ExternalLink, InLinkContext, mdComponents, nodeText, rehypePlugins, remarkPlugins } from "../chat/markdown";
import { resolveLink } from "./links";
import { MarkdownImage } from "./MarkdownImage";
import { Outline, type Heading } from "./Outline";
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
  /** Machine and root that relative images are read from. */
  machineId: string;
  root: string;
  text: string;
  rel: string;
  /** Opens a linked file; `hash` is its decoded `#fragment`, if any. */
  onOpen(rel: string, hash: string | null): void;
  initialScroll: number;
  /** A heading to show instead of the remembered position (a `doc.md#section` link). */
  initialHash?: string | null;
  saveScroll(path: string, top: number): void;
  /** Whether to show the outline column (when the document has headings). */
  outline?: boolean;
  /** Told whether the document has headings to outline; `false` again on unmount. */
  onOutline?(has: boolean): void;
}

const readHeadings = (root: HTMLElement): Heading[] =>
  [...root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")].map((el) => ({
    id: el.id,
    level: Number(el.tagName[1]),
    text: el.textContent ?? "",
  }));

/** The last heading at or above the top of the scroller (with a little slack), else the first. */
function activeHeading(root: HTMLElement, items: Heading[]): string | null {
  const top = root.getBoundingClientRect().top + 24;
  let current = items[0]?.id ?? null;
  for (const h of items) {
    const el = byId(root, h.id);
    if (!el || el.getBoundingClientRect().top > top) break;
    current = h.id;
  }
  return current;
}

/** One mount per file, so scroll memory pairs with the right file. */
export function MarkdownView(props: Props) {
  return <RenderedMarkdown key={props.rel} {...props} />;
}

function RenderedMarkdown({ machineId, root: fileRoot, text, rel, onOpen, initialScroll, initialHash, saveScroll, outline = false, onOutline }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const saveOnScroll = useScrollMemory(rel, initialScroll, saveScroll);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const frame = useRef(0);
  useLayoutEffect(() => {
    if (!root.current) return;
    const items = readHeadings(root.current);
    setHeadings(items);
    setActiveId(activeHeading(root.current, items));
  }, [text]);
  const has = headings.length > 0;
  useEffect(() => onOutline?.(has), [has, onOutline]);
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    onOutline?.(false);
  }, [onOutline]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    saveOnScroll(e);
    if (!outline || !has) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => root.current && setActiveId(activeHeading(root.current, headings)));
  };
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
      // An image inside the root loads from the Machine; any other keeps the chat's rule (never loaded).
      img(props) {
        const link = typeof props.src === "string" ? resolveLink(rel, props.src) : null;
        if (link?.kind === "file") return <MarkdownImage machineId={machineId} root={fileRoot} rel={link.rel} alt={props.alt ?? ""} title={props.title} />;
        const Img = mdComponents.img as (p: typeof props) => React.ReactNode;
        return <Img {...props} />;
      },
    }),
    [rel, onOpen, machineId, fileRoot],
  );
  return (
    <div className="files-markdown-wrap">
      <div className="files-markdown chat-assistant" ref={root} onScroll={onScroll}>
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={viewRehypePlugins} components={components}>{text}</Markdown>
      </div>
      {outline && has && (
        <Outline
          items={headings}
          activeId={activeId}
          onSelect={(id) => {
            byId(root.current, id)?.scrollIntoView();
            setActiveId(id);
          }}
        />
      )}
    </div>
  );
}
