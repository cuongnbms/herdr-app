import { memo, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { ChatItem } from "../lib/types";
import { CheckIcon, ChevronIcon, CopyIcon } from "../ui/icons";
import { checklist, checklistSummary, type ChecklistRow } from "./checklist";
import { ChatImages } from "./images";
import { SkillChips } from "./skills";
import { toolIcon } from "./toolIcon";

/** The fenced block's language, from the `language-x` class rehype-highlight leaves on `<code>`. */
function codeLanguage(node: unknown): string | null {
  const code = (node as { children?: { properties?: { className?: unknown } }[] } | undefined)?.children?.[0];
  const cls = code?.properties?.className;
  const list = Array.isArray(cls) ? cls : [];
  const lang = list.find((c): c is string => typeof c === "string" && c.startsWith("language-"));
  return lang ? lang.slice("language-".length) : null;
}

const mdComponents: Components = {
  pre({ node, children }) {
    return (
      <div className="chat-code">
        <div className="chat-code-head">{codeLanguage(node) ?? "code"}</div>
        <pre>{children}</pre>
      </div>
    );
  },
  a({ href, children }) {
    const external = !!href && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (external) void openUrl(href).catch((err) => console.error("openUrl failed", err));
        }}
      >
        {children}
      </a>
    );
  },
};
const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;

type ToolResult = Extract<ChatItem, { kind: "tool_result" }>;

function lines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <pre className="chat-diff">
      {lines(oldText).map((l, i) => (
        <div key={`o${i}`} className="diff-del">{`- ${l}`}</div>
      ))}
      {lines(newText).map((l, i) => (
        <div key={`n${i}`} className="diff-add">{`+ ${l}`}</div>
      ))}
    </pre>
  );
}

const str = (v: unknown): v is string => typeof v === "string";

/** Edit, MultiEdit and Write inputs as diffs; null when the input is not an edit. */
function diffsFor(input: Record<string, unknown>) {
  if (str(input.old_string) && str(input.new_string)) return [{ o: input.old_string, n: input.new_string }];
  if (Array.isArray(input.edits)) {
    const d = (input.edits as Record<string, unknown>[])
      .filter((e) => e && str(e.old_string) && str(e.new_string))
      .map((e) => ({ o: e.old_string as string, n: e.new_string as string }));
    if (d.length) return d;
  }
  if (str(input.file_path) && str(input.content)) return [{ o: "", n: input.content }];
  return null;
}

const MARK: Record<ChecklistRow["status"], string> = { completed: "☑", in_progress: "◐", pending: "☐" };

function Checklist({ rows }: { rows: ChecklistRow[] }) {
  return (
    <ul className="chat-checklist" aria-label="Todos">
      {rows.map((r, i) => (
        <li key={i} className={r.status}>
          <span className="chat-checklist-mark" aria-hidden="true">{MARK[r.status]}</span>
          <span>{r.label}</span>
        </li>
      ))}
    </ul>
  );
}

function ToolCallView({ item, result }: { item: Extract<ChatItem, { kind: "tool_call" }>; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const input = (item.input ?? {}) as Record<string, unknown>;
  const ToolIcon = toolIcon(item.name);
  const todos = checklist(item.input);
  if (todos) {
    return (
      <div className="chat-tool">
        <button className="chat-tool-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronIcon className={"icon chev" + (open ? " open" : "")} />
          <ToolIcon className="icon chat-tool-icon" />
          <span className="chat-tool-name">{item.name}</span>
          <span className="chat-tool-sep"> · </span>
          <span className="chat-tool-summary">{checklistSummary(todos)}</span>
        </button>
        {open && (
          <div className="chat-tool-body">
            <Checklist rows={todos} />
            {/* The list is the input; a successful answer only says so again. */}
            {result?.is_error && <pre className="chat-result error">{result.output}</pre>}
          </div>
        )}
      </div>
    );
  }
  const diffs = diffsFor(input);
  return (
    <div className="chat-tool">
      <button className="chat-tool-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronIcon className={"icon chev" + (open ? " open" : "")} />
        <ToolIcon className="icon chat-tool-icon" />
        <span className="chat-tool-name">{item.name}</span>
        <span className="chat-tool-sep"> · </span>
        <span className="chat-tool-summary">{item.input_summary}</span>
      </button>
      {open && (
        <div className="chat-tool-body">
          {diffs?.map((d, i) => <Diff key={i} oldText={d.o} newText={d.n} />)}
          {result ? (
            <>
              {!!result.images?.length && <ChatImages images={result.images} />}
              <pre className={result.is_error ? "chat-result error" : "chat-result"}>{result.output}</pre>
            </>
          ) : (
            !diffs && <div className="chat-dim">No result yet</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Copies the text and says so for a moment. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="chat-copy"
      aria-label={copied ? "Copied" : "Copy"}
      title={copied ? "Copied" : "Copy"}
      onClick={() =>
        // Through a promise, so a webview without the Clipboard API fails here, not in the handler.
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
          () => setCopied(true),
          (e) => console.error("copy failed", e),
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** `copy`: offer a copy button on a user message or an answer (not on narration inside a work block). */
export const ChatItemView = memo(function ChatItemView({ item, result, copy = false }: { item: ChatItem; result?: ToolResult; copy?: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-row chat-user">
          {!!item.images?.length && <ChatImages images={item.images} />}
          {item.text !== "" && (
            <div className="chat-user-line">
              <div className="chat-bubble">{item.text}</div>
              {copy && <CopyButton text={item.text} />}
            </div>
          )}
          {!!item.skills?.length && <SkillChips chips={item.skills.map((s) => ({ name: s.name, path: s.path, status: "loaded" }))} />}
        </div>
      );
    case "assistant_text":
      return (
        <div className="chat-row chat-assistant">
          <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>{item.markdown}</Markdown>
          {copy && <CopyButton text={item.markdown} />}
        </div>
      );
    case "thinking":
      return (
        <details className="chat-row chat-thinking">
          <summary>Thinking…</summary>
          <div className="chat-dim">{item.text}</div>
        </details>
      );
    case "tool_call":
      return (
        <div className="chat-row">
          <ToolCallView item={item} result={result} />
        </div>
      );
    case "tool_result":
      return (
        <div className="chat-row">
          {!!item.images?.length && <ChatImages images={item.images} />}
          <pre className={item.is_error ? "chat-result error" : "chat-result"}>{item.output}</pre>
        </div>
      );
    case "system":
      return <div className="chat-row chat-system">{item.text}</div>;
  }
});
