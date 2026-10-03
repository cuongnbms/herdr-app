import { memo } from "react";
import { ChevronIcon } from "../ui/icons";
import { ChatItemView } from "./ChatItemView";
import { formatWorkDuration, workSummary, type ToolResult, type WorkBlock } from "./workBlocks";

/**
 * One turn's work under one header ("Worked for 7s · 1 edit"). Controlled: the Chat lens keeps
 * open/closed, since a virtualized row unmounts when it scrolls away.
 */
export const WorkBlockView = memo(function WorkBlockView({
  block,
  results,
  open,
  onToggle,
  live,
}: {
  block: WorkBlock;
  results: Map<string, ToolResult>;
  open: boolean;
  onToggle: () => void;
  live: boolean;
}) {
  const duration = formatWorkDuration(block.start, block.end);
  const title = live ? "Working…" : duration ? `Worked for ${duration}` : "Worked";
  const summary = workSummary(block.items, results);
  return (
    <div className="chat-row chat-work">
      <button className="chat-work-head" aria-expanded={open} onClick={onToggle}>
        <ChevronIcon className={"icon chev" + (open ? " open" : "")} />
        <span className="chat-work-title">{title}</span>
        {summary && (
          <>
            {" · "}
            <span className="chat-work-summary">{summary}</span>
          </>
        )}
      </button>
      {open && (
        <div className="chat-work-rows">
          {block.items.map((it, i) => (
            <div key={i} className={it.kind === "assistant_text" ? "chat-narration" : undefined}>
              <ChatItemView item={it} result={it.kind === "tool_call" ? results.get(it.id) : undefined} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
