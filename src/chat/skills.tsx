import type { ChatItem } from "../lib/types";
import { BookIcon } from "../ui/icons";
import type { ToolResult } from "./workBlocks";

export interface SkillChip {
  name: string;
  status: "requested" | "loaded" | "failed";
  path?: string;
}

const VALID_NAME = /^[^\r\n<>]{1,200}$/;

/** The Skills a turn's `Skill` tool calls used: one chip per name, at its first position, with the latest use's status. */
export function turnSkills(items: ChatItem[], results: Map<string, ToolResult>): SkillChip[] {
  const chips: SkillChip[] = [];
  for (const it of items) {
    if (it.kind !== "tool_call" || it.name !== "Skill") continue;
    const name = (it.input as { skill?: unknown } | null | undefined)?.skill;
    if (typeof name !== "string" || !VALID_NAME.test(name)) continue;
    const res = results.get(it.id);
    const status = !res ? "requested" : res.is_error ? "failed" : "loaded";
    const existing = chips.find((c) => c.name === name);
    if (existing) existing.status = status;
    else chips.push({ name, status });
  }
  return chips;
}

export function SkillChips({ chips }: { chips: SkillChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="skill-chips">
      {chips.map((c) => (
        <span key={c.name} className="skill-chip" title={c.path}>
          <BookIcon />
          {c.name}
          <span className="skill-chip-status">{c.status}</span>
        </span>
      ))}
    </div>
  );
}
