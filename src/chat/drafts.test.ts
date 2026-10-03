import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_WRITE_MS, readDraft, useDraft, writeDraft } from "./drafts";

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

describe("useDraft", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes once typing pauses", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { rerender } = renderHook(({ text }) => useDraft("k", text), { initialProps: { text: "a" } });
    rerender({ text: "ab" });
    rerender({ text: "abc" });
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DRAFT_WRITE_MS);
    expect(setItem).toHaveBeenCalledOnce();
    expect(readDraft("k")).toBe("abc");
  });

  it("flushes the pending text on unmount", () => {
    const { rerender, unmount } = renderHook(({ text }) => useDraft("k", text), { initialProps: { text: "a" } });
    rerender({ text: "half a thought" });
    unmount();
    expect(readDraft("k")).toBe("half a thought");
  });

  it("flushes to the old pane when the pane changes", () => {
    const { rerender } = renderHook(({ k, text }) => useDraft(k, text), { initialProps: { k: "p1", text: "for p1" } });
    rerender({ k: "p2", text: "" });
    expect(readDraft("p1")).toBe("for p1");
    expect(readDraft("p2")).toBe("");
  });

  it("flushes when the page is hidden", () => {
    renderHook(() => useDraft("k", "quitting"));
    window.dispatchEvent(new Event("pagehide"));
    expect(readDraft("k")).toBe("quitting");
  });

  it("forgets an emptied draft at once", () => {
    writeDraft("k", "sent");
    const { rerender } = renderHook(({ text }) => useDraft("k", text), { initialProps: { text: "sent" } });
    rerender({ text: "" });
    expect(readDraft("k")).toBe("");
    vi.advanceTimersByTime(DRAFT_WRITE_MS);
    expect(readDraft("k")).toBe("");
  });
});
