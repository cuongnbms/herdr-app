import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { ExternalLink, InLinkContext, mdComponents, nodeText, rehypePlugins, remarkPlugins } from "../chat/markdown";
import { clearHighlights, findRanges, firstVisible, repaint, reveal, setHighlight } from "./domFind";
import { wrapIndex, type FindQuery, type FindStatus } from "./find";
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

/**
 * Raw HTML in a file is kept to GitHub's safe set (`<details>`, `<kbd>`, `<sub>`, `<br>`…):
 * no scripts, frames, styles or event handlers. `<picture>`/`<source>` go too, as their
 * `srcset` would load remote images; `<img>` goes through the `img` component, which loads
 * only images inside the root. Raw `id`s and `name`s get a `user-content-` prefix so they
 * cannot clobber the app's own; anchor lookups below try the prefixed id as well.
 */
const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((t) => t !== "picture" && t !== "source"),
  // A dropped tag keeps its children; these hold raw text (CSS, fallback markup) that must go too.
  strip: [...(defaultSchema.strip ?? []), "style", "noscript", "textarea", "title", "template"],
};

// Sanitizing runs before anything that adds classes (highlighting) and before heading ids.
const viewRehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  ...(rehypePlugins as unknown as unknown[]),
  rehypeHeadingIds,
] as never;

const byId = (root: HTMLElement | null, id: string) =>
  root?.querySelector(`[id="${CSS.escape(id)}"]`) ?? root?.querySelector(`[id="${CSS.escape(`user-content-${id}`)}"]`) ?? null;

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
  /** `index` is the number of steps taken from the first match on screen; it wraps here. */
  find?: FindQuery | null;
  /** Told the match count and the current match whenever either changes. */
  onFindStatus?(status: FindStatus): void;
}

const MATCH = "files-find";
const CURRENT = "files-find-current";

/**
 * Find in the rendered text under `root`. Matches are painted with the CSS Custom Highlight
 * API: the DOM belongs to React and mermaid, so marking matches must not add elements to it.
 */
function useDomFind(root: React.RefObject<HTMLDivElement | null>, find: FindQuery | null | undefined, onFindStatus?: (s: FindStatus) => void) {
  const query = find?.query ?? "";
  const matchCase = find?.matchCase ?? false;
  const steps = find?.index ?? 0;
  /** `fresh` marks a new search (it scrolls to its match); a content change keeps the view. */
  const [found, setFound] = useState<{ ranges: Range[]; base: number; fresh: boolean }>({ ranges: [], base: 0, fresh: false });
  // Bumped when the rendered DOM changes after the first paint (reload, mermaid, images).
  const [contentSeq, setContentSeq] = useState(0);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setContentSeq((n) => n + 1), 50);
    });
    // `open` too: a <details> toggled open shows text to find. (Not `style`: repaint() writes it.)
    observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [root]);

  // A new search starts at the first match on screen, so it begins where you are reading.
  useLayoutEffect(() => {
    const el = root.current;
    const ranges = el && query ? findRanges(el, query, matchCase) : [];
    setFound({ ranges, base: el ? firstVisible(ranges, el) : 0, fresh: true });
  }, [root, query, matchCase]);

  useEffect(() => {
    const el = root.current;
    if (!contentSeq || !el || !query) return;
    const ranges = findRanges(el, query, matchCase);
    setFound((f) => ({ ranges, base: Math.min(f.base, Math.max(0, ranges.length - 1)), fresh: false }));
  }, [contentSeq]);

  const count = found.ranges.length;
  const index = count ? wrapIndex(found.base, steps, count) : 0;
  const report = useRef(onFindStatus);
  report.current = onFindStatus;
  useEffect(() => report.current?.({ count, index }), [count, index]);

  // Whether highlights are painted now: with none before or after, there is nothing to repaint.
  const painted = useRef(false);
  useEffect(() => {
    if (count) {
      setHighlight(MATCH, found.ranges);
      setHighlight(CURRENT, [found.ranges[index]]);
    } else if (painted.current) clearHighlights(MATCH, CURRENT);
    else return;
    painted.current = count > 0;
    repaint(root.current);
  }, [found, index]);

  // `steps` is not wrapped, so stepping onto the same match, as with a single match, reveals it again.
  const revealed = useRef<{ found: unknown; steps: number }>({ found: null, steps: 0 });
  useEffect(() => {
    const last = revealed.current;
    const moved = (found !== last.found && found.fresh) || steps !== last.steps;
    revealed.current = { found, steps };
    if (moved && count && root.current) reveal(found.ranges[index], root.current);
  }, [found, steps]);

  useEffect(
    () => () => {
      if (painted.current) clearHighlights(MATCH, CURRENT);
    },
    [root],
  );
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

function RenderedMarkdown({ machineId, root: fileRoot, text, rel, onOpen, initialScroll, initialHash, saveScroll, outline = false, onOutline, find, onFindStatus }: Props) {
  const root = useRef<HTMLDivElement>(null);
  useDomFind(root, find, onFindStatus);
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
  // Parsing and highlighting the document is the slow part; find re-renders this view on every
  // keystroke, so the same element lets React skip the document.
  const doc = useMemo(
    () => <Markdown remarkPlugins={remarkPlugins} rehypePlugins={viewRehypePlugins} components={components}>{text}</Markdown>,
    [text, components],
  );
  return (
    <div className="files-markdown-wrap">
      <div className="files-markdown chat-assistant" ref={root} onScroll={onScroll}>
        {doc}
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
