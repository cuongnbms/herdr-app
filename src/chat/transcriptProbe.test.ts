import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { paneKey, type AgentStatus, type PaneRef } from "../lib/types";
import { useApp } from "../store/app";
import { useLensSettings } from "../settings/lens";
import { useTranscriptProbe } from "./transcriptProbe";
import { showToast } from "../ui/Toast";

vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));

const pane: PaneRef = { machine_id: "local", session: "default", pane_id: "w1:p1" };
const key = paneKey(pane);
const located = { agent: "claude", path: "/p/fresh.jsonl", ambiguous: false, candidates: [], pending: false };
const notFound = { code: "not_found", message: "no transcript yet" };

describe("useTranscriptProbe", () => {
  beforeEach(() => {
    useApp.setState({ lensOverride: { [key]: "terminal" } });
    vi.mocked(showToast).mockClear();
    useLensSettings.setState({ chatAfterFirstPrompt: true });
  });

  it("stays on the Terminal lens when switching to Chat after the first prompt is turned off", async () => {
    useLensSettings.setState({ chatAfterFirstPrompt: false });
    const locate = vi.fn().mockResolvedValue(located);
    renderHook(() => useTranscriptProbe(pane, "working", locate));
    await new Promise((r) => setTimeout(r, 0));
    expect(locate).not.toHaveBeenCalled();
    expect(useApp.getState().lensOverride[key]).toBe("terminal");
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
    expect(showToast).toHaveBeenCalledWith("Switched to Chat", { alert: false });
  });

  it("looks again only when the agent starts or finishes work", async () => {
    const locate = vi.fn().mockRejectedValue(notFound);
    const { rerender } = renderHook(
      ({ status }: { status: AgentStatus }) => useTranscriptProbe(pane, status, locate, 10_000),
      { initialProps: { status: "idle" as AgentStatus } },
    );
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    for (const status of ["blocked", "idle", "unknown"] as AgentStatus[]) rerender({ status });
    await new Promise((r) => setTimeout(r, 0));
    expect(locate).toHaveBeenCalledTimes(1);
    rerender({ status: "working" });
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    rerender({ status: "done" });
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(3));
  });

  it("looks once more shortly after a miss, for a file written just after the status change", async () => {
    const locate = vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce(located);
    renderHook(() => useTranscriptProbe(pane, "working", locate, 10));
    await waitFor(() => expect(useApp.getState().lensOverride[key]).toBeUndefined());
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("does not take a guessed Claude transcript, made before herdr reports the session", async () => {
    const guessed = { ...located, ambiguous: true, candidates: ["/p/old.jsonl"] };
    const locate = vi.fn().mockResolvedValue(guessed);
    renderHook(() => useTranscriptProbe(pane, "idle", locate, 10));
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    expect(useApp.getState().lensOverride[key]).toBe("terminal");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("does nothing for a pane without a fallback", async () => {
    useApp.setState({ lensOverride: {} });
    const locate = vi.fn().mockResolvedValue(located);
    renderHook(() => useTranscriptProbe(pane, "working", locate));
    await new Promise((r) => setTimeout(r, 0));
    expect(locate).not.toHaveBeenCalled();
  });
});
