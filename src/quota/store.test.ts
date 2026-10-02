import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ quotaFetch: vi.fn() }));
import { quotaFetch } from "../lib/ipc";
import type { QuotaOutcome } from "../lib/types";
import { initialSlots, useQuota } from "./store";

const fetchMock = vi.mocked(quotaFetch);
const okWindows = [{ label: "5h", usedPercent: 19, resetsAt: null, durationSecs: 18_000 }];
const okOutcome: QuotaOutcome = { kind: "ok", windows: okWindows, fetchedAt: 1 };

describe("useQuota", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useQuota.setState({ slots: initialSlots() });
  });

  it("fetches every Provider once and stores the outcomes", async () => {
    fetchMock.mockImplementation(async (p) => (p === "claude" ? okOutcome : { kind: "notSignedIn" }));
    await useQuota.getState().refresh("shown");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const s = useQuota.getState().slots;
    expect(s.claude.entry).toEqual({ kind: "ok", report: { windows: okWindows, fetchedAt: 1 } });
    expect(s.codex.entry).toEqual({ kind: "notSignedIn" });
    expect(s.claude.inFlight).toBe(false);
    expect(s.claude.lastStarted).not.toBeNull();
  });

  it("does not start a second fetch while one is in flight", async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise<QuotaOutcome>((r) => (release = () => r({ kind: "notSignedIn" }))));
    void useQuota.getState().refresh("manual");
    void useQuota.getState().refresh("manual");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(useQuota.getState().slots.grok.inFlight).toBe(true);
    release();
    fetchMock.mockResolvedValue({ kind: "notSignedIn" });
  });

  it("respects the schedule: shown twice within a minute fetches once", async () => {
    fetchMock.mockResolvedValue({ kind: "notSignedIn" });
    await useQuota.getState().refresh("shown");
    await useQuota.getState().refresh("shown");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("remembers a rate limit and waits it out even for manual refresh", async () => {
    fetchMock.mockResolvedValue({ kind: "rateLimited", until: Date.now() + 60_000 });
    await useQuota.getState().refresh("manual");
    expect(useQuota.getState().slots.claude.rateLimitedUntil).not.toBeNull();
    await useQuota.getState().refresh("manual");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a rejected invoke becomes a problem and clears in-flight", async () => {
    fetchMock.mockRejectedValue(new Error("command quota_fetch not found"));
    await useQuota.getState().refresh("manual");
    const slot = useQuota.getState().slots.claude;
    expect(slot.inFlight).toBe(false);
    expect(slot.entry).toEqual({ kind: "problem", message: "command quota_fetch not found", last: null });
  });
});
