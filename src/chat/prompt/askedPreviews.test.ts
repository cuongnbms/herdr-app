import { describe, expect, test } from "vitest";
import type { ChatItem } from "../../lib/types";
import { pendingQuestions, previewsFor } from "./askedPreviews";
import type { ScreenPrompt } from "./screenPrompt";

const ask = (id: string, question: string, previews: (string | undefined)[]): ChatItem => ({
  kind: "tool_call", id, name: "AskUserQuestion", input_summary: "",
  input: { questions: [{ question, header: "Style", multiSelect: false,
    options: previews.map((preview, i) => ({ label: ["Timeline (Recommended)", "Card / pill"][i], description: "", ...(preview ? { preview } : {}) })) }] },
});
const prompt = (question: string, labels = ["Timeline (Recommended)", "Card / pill"]) =>
  ({ question, options: labels.map((label) => ({ label, description: null })) }) as ScreenPrompt;

describe("pendingQuestions", () => {
  test("reads the last AskUserQuestion still waiting for its answer", () => {
    const items: ChatItem[] = [
      ask("a", "Old?", ["x", "y"]),
      { kind: "tool_result", call_id: "a", output: "", is_error: false },
      ask("b", "Pick a layout?", ["o 09:00\n| |", undefined]),
    ];
    expect(pendingQuestions(items)).toEqual([{ question: "Pick a layout?", options: [
      { label: "Timeline (Recommended)", preview: "o 09:00\n| |" }, { label: "Card / pill", preview: null },
    ] }]);
  });

  test("has nothing once the last call is answered", () => {
    expect(pendingQuestions([ask("a", "Q?", ["x", "y"]), { kind: "tool_result", call_id: "a", output: "", is_error: false }])).toEqual([]);
    expect(pendingQuestions([])).toEqual([]);
  });
});

describe("previewsFor", () => {
  const asked = pendingQuestions([ask("b", "Pick a  layout?", ["one", "two"])]);
  test("matches the screen's question and labels, a cut-short label by its start", () => {
    expect(previewsFor(prompt("Pick a layout?"), asked)).toEqual(["one", "two"]);
    expect(previewsFor(prompt("Pick a layout?", ["Timeline (Rec…", "Card / pill"]), asked)).toEqual(["one", "two"]);
  });
  test("is null for another question, other options, or no previews", () => {
    expect(previewsFor(prompt("Other?"), asked)).toBeNull();
    expect(previewsFor(prompt("Pick a layout?", ["A", "B"]), asked)).toBeNull();
    expect(previewsFor(prompt("Q?"), pendingQuestions([ask("c", "Q?", [undefined, undefined])]))).toBeNull();
  });
});
