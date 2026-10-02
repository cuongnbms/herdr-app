import { memo, useState } from "react";
import Markdown from "react-markdown";
import type { ChatItem } from "../lib/types";

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

function ToolCallView({ item, result }: { item: Extract<ChatItem, { kind: "tool_call" }>; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const input = (item.input ?? {}) as Record<string, unknown>;
  const isEdit = typeof input.old_string === "string" && typeof input.new_string === "string";
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
          {isEdit && <Diff oldText={input.old_string as string} newText={input.new_string as string} />}
          {result ? (
            <pre className={result.is_error ? "chat-result error" : "chat-result"}>{result.output}</pre>
          ) : (
            !isEdit && <div className="chat-dim">No result yet</div>
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
          <Markdown>{item.markdown}</Markdown>
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
