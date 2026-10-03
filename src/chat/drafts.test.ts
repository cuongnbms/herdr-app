import { beforeEach, describe, expect, it } from "vitest";
import { readDraft, writeDraft } from "./drafts";

beforeEach(() => localStorage.clear());

describe("drafts", () => {
  it("keeps one draft per pane", () => {
    writeDraft("devtuf/default/w1:p1", "fix the bug");
    writeDraft("devtuf/default/w1:p2", "run the tests");
    expect(readDraft("devtuf/default/w1:p1")).toBe("fix the bug");
    expect(readDraft("devtuf/default/w1:p2")).toBe("run the tests");
    expect(readDraft("devtuf/default/w1:p3")).toBe("");
  });

  it("forgets an emptied draft", () => {
    writeDraft("k", "hello");
    writeDraft("k", "");
    expect(readDraft("k")).toBe("");
    expect(localStorage.length).toBe(0);
  });
});
