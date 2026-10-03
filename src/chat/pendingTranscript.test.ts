import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentStatus, Located } from "../lib/types";
import { usePendingTranscript } from "./pendingTranscript";

const pane = { machine_id: "m", session: "default", pane_id: "w1:p1" };
const expected: Located = { agent: "claude", path: "/h/.claude/projects/-w-app/sid.jsonl", ambiguous: false, candidates: [], pending: true };
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(located: Located | null, empty: boolean, found: Located) {
  const locate = vi.fn().mockResolvedValue(found);
  const reopen = vi.fn();
  const hook = renderHook(
    ({ status }: { status: AgentStatus }) => usePendingTranscript(pane, located, empty, status, reopen, locate, 10),
    { initialProps: { status: "idle" as AgentStatus } },
  );
  return { locate, reopen, ...hook };
}

describe("usePendingTranscript", () => {
  it("reopens when the first prompt's transcript turns up somewhere other than expected", async () => {
    const elsewhere = { ...expected, path: "/h/.claude/projects/-w-other/sid.jsonl", pending: false };
    const { locate, reopen, rerender } = setup(expected, true, elsewhere);
    rerender({ status: "working" });
    await flush();
    expect(locate).toHaveBeenCalledWith(pane);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("stays on the expected path while it is still where Claude will write", async () => {
    const { locate, reopen, rerender } = setup(expected, true, expected);
    rerender({ status: "working" });
    await new Promise((r) => setTimeout(r, 30));
    expect(locate).toHaveBeenCalledTimes(3); // shown, status change, one retry
    expect(reopen).not.toHaveBeenCalled();
  });

  it("does nothing once the chat has items or the transcript is not pending", async () => {
    const elsewhere = { ...expected, path: "/x.jsonl", pending: false };
    const a = setup(expected, false, elsewhere);
    const b = setup({ ...expected, pending: false }, true, elsewhere);
    const c = setup(null, true, elsewhere);
    for (const h of [a, b, c]) h.rerender({ status: "working" });
    await new Promise((r) => setTimeout(r, 30));
    for (const h of [a, b, c]) {
      expect(h.locate).not.toHaveBeenCalled();
      expect(h.reopen).not.toHaveBeenCalled();
    }
  });
});
