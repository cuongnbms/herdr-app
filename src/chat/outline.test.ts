import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/types";
import { currentEntry, outline } from "./outline";
import { buildRows } from "./workBlocks";

const user = (text: string, extra: Partial<Extract<ChatItem, { kind: "user" }>> = {}): ChatItem => ({ kind: "user", text, ...extra });
const answer = (markdown: string): ChatItem => ({ kind: "assistant_text", markdown });
const call = (id: string): ChatItem => ({ kind: "tool_call", id, name: "Bash", input_summary: "ls", input: {} });

describe("outline", () => {
  it("lists each user turn with its row index", () => {
    const { rows } = buildRows([user("first"), answer("a"), user("second"), call("t1"), answer("b")], 0);
    const entries = outline(rows);
    expect(entries.map((e) => e.label)).toEqual(["first", "second"]);
    for (const e of entries) expect(rows[e.row]).toMatchObject({ kind: "item", item: { kind: "user" } });
  });

  it("lists a shell command as a turn", () => {
    const { rows } = buildRows([user("first"), { kind: "shell_command", command: "git status" }, { kind: "shell_output", stdout: "clean", stderr: "" }], 0);
    expect(outline(rows).map((e) => e.label)).toEqual(["first", "!git status"]);
  });

  it("labels a turn by its first non-empty line", () => {
    const { rows } = buildRows([user("\n\n  fix the header  \nthen the footer")], 0);
    expect(outline(rows)[0].label).toBe("fix the header");
  });

  it("falls back to the skill, then to the image, when there is no text", () => {
    const { rows } = buildRows(
      [
        user("", { skills: [{ name: "commit", path: "/s/commit" }] }),
        user("", { images: [{ id: "i1" } as never] }),
      ],
      0,
    );
    expect(outline(rows).map((e) => e.label)).toEqual(["/commit", "Image"]);
  });
});

describe("currentEntry", () => {
  const entries = [
    { row: 0, key: "a", label: "a" },
    { row: 4, key: "b", label: "b" },
    { row: 9, key: "c", label: "c" },
  ];

  it("picks the last turn starting at or above the top visible row", () => {
    expect(currentEntry(entries, 0)).toBe(0);
    expect(currentEntry(entries, 5)).toBe(1);
    expect(currentEntry(entries, 9)).toBe(2);
    expect(currentEntry(entries, 20)).toBe(2);
  });

  it("is the last turn once scrolled to the end, though it cannot reach the top", () => {
    expect(currentEntry(entries, 5, true)).toBe(2);
    expect(currentEntry([], 5, true)).toBe(-1);
  });

  it("is the first turn when the view starts above it, and none without turns", () => {
    expect(currentEntry([{ row: 2, key: "a", label: "a" }], 0)).toBe(0);
    expect(currentEntry([], 3)).toBe(-1);
  });
});
