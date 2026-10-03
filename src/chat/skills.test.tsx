import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/types";
import { WorkBlockView } from "./WorkBlockView";
import { ChatItemView } from "./ChatItemView";
import { turnSkills } from "./skills";
import type { ToolResult, WorkBlock } from "./workBlocks";

const call = (id: string, skill: unknown): ChatItem => ({ kind: "tool_call", id, name: "Skill", input_summary: String(skill), input: { skill } });
const result = (id: string, is_error: boolean): ToolResult => ({ kind: "tool_result", call_id: id, output: "", is_error });

describe("turnSkills", () => {
  it("reads status from the result and keeps the latest use per name", () => {
    const items = [call("1", "tdd"), call("2", "review"), call("3", "tdd"), call("4", "bad\nname"), { kind: "tool_call", id: "5", name: "Bash", input_summary: "", input: { skill: "x" } } as ChatItem];
    const results = new Map([["1", result("1", true)], ["3", result("3", false)]]);
    expect(turnSkills(items, results)).toEqual([
      { name: "tdd", status: "loaded" },
      { name: "review", status: "requested" },
    ]);
  });
  it("marks a failed use", () => {
    expect(turnSkills([call("1", "tdd")], new Map([["1", result("1", true)]]))).toEqual([{ name: "tdd", status: "failed" }]);
  });
});

describe("Skill chips", () => {
  it("shows chips while folded", () => {
    const block: WorkBlock = { id: "b", items: [call("1", "tdd")], start: null, end: null };
    render(<WorkBlockView block={block} results={new Map()} open={false} onToggle={() => {}} live={false} />);
    expect(screen.getByText("tdd")).toBeTruthy();
    expect(screen.getByText("requested")).toBeTruthy();
  });
  it("shows a pi Skill under the user bubble", () => {
    render(<ChatItemView item={{ kind: "user", text: "/skill:tdd", skills: [{ name: "tdd", path: "/t/SKILL.md" }] }} />);
    const chip = screen.getByText("tdd").closest(".skill-chip")!;
    expect(chip.getAttribute("title")).toBe("/t/SKILL.md");
    expect(screen.getByText("loaded")).toBeTruthy();
  });
});
