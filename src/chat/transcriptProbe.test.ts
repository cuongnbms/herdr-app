import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { paneKey, type AgentStatus, type PaneRef } from "../lib/types";
import { useApp } from "../store/app";
import { useTranscriptProbe } from "./transcriptProbe";

const pane: PaneRef = { machine_id: "local", session: "default", pane_id: "w1:p1" };
const key = paneKey(pane);
const located = { agent: "claude", path: "/p/fresh.jsonl", ambiguous: false, candidates: [] };
const notFound = { code: "not_found", message: "no transcript yet" };

describe("useTranscriptProbe", () => {
  beforeEach(() => {
    useApp.setState({ lensOverride: { [key]: "terminal" }, lensNote: { [key]: "No conversation transcript" } });
  });

  it("returns to the Chat lens once the fallen-back pane's transcript exists", async () => {
    const locate = vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce(located);
    const { rerender } = renderHook(({ status }: { status: AgentStatus }) => useTranscriptProbe(pane, status, locate), {
      initialProps: { status: "idle" },
    });
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    expect(useApp.getState().lensOverride[key]).toBe("terminal");

    rerender({ status: "working" });
    await waitFor(() => expect(useApp.getState().lensOverride[key]).toBeUndefined());
    expect(useApp.getState().lensNote[key]).toBeUndefined();
  });

  it("looks once more shortly after a miss, for a file written just after the status change", async () => {
    const locate = vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce(located);
    renderHook(() => useTranscriptProbe(pane, "working", locate, 10));
    await waitFor(() => expect(useApp.getState().lensOverride[key]).toBeUndefined());
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a pane without a fallback", async () => {
    useApp.setState({ lensOverride: {} });
    const locate = vi.fn().mockResolvedValue(located);
    renderHook(() => useTranscriptProbe(pane, "working", locate));
    await new Promise((r) => setTimeout(r, 0));
    expect(locate).not.toHaveBeenCalled();
  });
});
