import { memo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { ChatItem } from "../lib/types";

const mdComponents: Components = {
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

function ToolCallView({ item, result }: { item: Extract<ChatItem, { kind: "tool_call" }>; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const input = (item.input ?? {}) as Record<string, unknown>;
  const diffs = diffsFor(input);
  return (
    <div className="chat-tool">
      <button className="chat-tool-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="chat-caret">{open ? "▾" : "▸"}</span>
        <span className="chat-tool-name">{item.name}</span>
        <span className="chat-tool-sep"> · </span>
        <span className="chat-tool-summary">{item.input_summary}</span>
      </button>
      {open && (
        <div className="chat-tool-body">
          {diffs?.map((d, i) => <Diff key={i} oldText={d.o} newText={d.n} />)}
          {result ? (
            <pre className={result.is_error ? "chat-result error" : "chat-result"}>{result.output}</pre>
          ) : (
            !diffs && <div className="chat-dim">No result yet</div>
          )}
        </div>
      )}
    </div>
  );
}

export const ChatItemView = memo(function ChatItemView({ item, result }: { item: ChatItem; result?: ToolResult }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-row chat-user">
          <div className="chat-bubble">{item.text}</div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="chat-row chat-assistant">
          <Markdown rehypePlugins={rehypePlugins} components={mdComponents}>{item.markdown}</Markdown>
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
          <pre className={item.is_error ? "chat-result error" : "chat-result"}>{item.output}</pre>
        </div>
      );
    case "system":
      return <div className="chat-row chat-system">{item.text}</div>;
  }
});
