import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ filesStat: vi.fn(), filesChanged: vi.fn() }));
import { filesChanged, filesStat } from "../lib/ipc";
import { usePolling } from "./usePolling";
import { POLL_MS } from "./limits";

describe("usePolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a changed mtime and a removed file, and stops when disabled", async () => {
    vi.mocked(filesChanged).mockResolvedValue({ repo: false, total: 0, changes: [] });
    vi.mocked(filesStat).mockResolvedValueOnce([{ size: 1, mtime: 2 }]).mockResolvedValueOnce([null]);
    const onChanged = vi.fn();
    const { rerender } = renderHook((p: { enabled: boolean }) =>
      usePolling({ enabled: p.enabled, machineId: "local", root: "/r", rel: "a", mtime: 1, size: 1, onChanged, onChanges: () => {} }),
      { initialProps: { enabled: true } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onChanged).toHaveBeenLastCalledWith();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onChanged).toHaveBeenLastCalledWith("removed");
    rerender({ enabled: false });
    const calls = vi.mocked(filesStat).mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(vi.mocked(filesStat).mock.calls.length).toBe(calls);
  });
});
