import { describe, expect, it } from "vitest";
import { checklist, checklistSummary } from "./checklist";

describe("checklist", () => {
  it("reads Claude's TodoWrite list", () => {
    const rows = checklist({ todos: [
      { content: "Write tests", status: "completed", activeForm: "Writing tests" },
      { content: "Implement", status: "in_progress" },
      { content: "Ship", status: "pending" },
    ] });
    expect(rows).toEqual([
      { label: "Write tests", status: "completed" },
      { label: "Implement", status: "in_progress" },
      { label: "Ship", status: "pending" },
    ]);
  });

  it("reads Codex's update_plan list", () => {
    expect(checklist({ plan: [{ step: "Plan", status: "completed" }] })).toEqual([{ label: "Plan", status: "completed" }]);
  });

  it("skips malformed entries and treats an unknown status as pending", () => {
    expect(checklist({ todos: [null, { content: 3 }, { content: "ok", status: "weird" }] })).toEqual([{ label: "ok", status: "pending" }]);
  });

  it("is null for input that carries no list", () => {
    expect(checklist({ command: "ls" })).toBeNull();
    expect(checklist(null)).toBeNull();
  });

  it("reads a cleared list as empty, not as no list", () => {
    expect(checklist({ todos: [] })).toEqual([]);
  });

  it("summarizes how many are done", () => {
    expect(checklistSummary([{ label: "a", status: "completed" }, { label: "b", status: "pending" }])).toBe("1/2 done");
  });
});
