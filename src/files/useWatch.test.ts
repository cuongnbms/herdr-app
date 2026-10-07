import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const channels = vi.hoisted(() => [] as { onmessage?: (e: unknown) => void }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage?: (e: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
}));
import { invoke } from "@tauri-apps/api/core";
import { useWatch } from "./useWatch";

const opts = (enabled: boolean) => ({
  enabled,
  machineId: "m",
  root: "/r",
  onChanges: vi.fn(),
  onResync: vi.fn(),
  onError: vi.fn(),
});

describe("useWatch", () => {
  beforeEach(() => {
    channels.length = 0;
    vi.mocked(invoke).mockReset();
    let id = 0;
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "files_watch" ? ++id : undefined));
  });

  it("does nothing while disabled", () => {
    renderHook(() => useWatch(opts(false)));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("subscribes, routes events, and unwatches its own id on cleanup", async () => {
    const o = opts(true);
    const { unmount } = renderHook(() => useWatch(o));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_watch", { machineId: "m", root: "/r", events: channels[0] }));
    channels[0].onmessage!({ type: "resync" });
    channels[0].onmessage!({ type: "changes", changes: [{ path: "a", isDir: false, removed: false }] });
    channels[0].onmessage!({ type: "error", message: "boom" });
    expect(o.onResync).toHaveBeenCalledTimes(1);
    expect(o.onChanges).toHaveBeenCalledWith([{ path: "a", isDir: false, removed: false }]);
    expect(o.onError).toHaveBeenCalledWith("boom");
    unmount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_unwatch", { id: 1 }));
  });

  it("re-subscribes for a new root and ignores the old channel", async () => {
    const o = opts(true);
    const { rerender } = renderHook((p: { root: string }) => useWatch({ ...o, root: p.root }), { initialProps: { root: "/r" } });
    await waitFor(() => expect(channels).toHaveLength(1));
    rerender({ root: "/s" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_watch", { machineId: "m", root: "/s", events: channels[1] }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_unwatch", { id: 1 }));
    channels[0].onmessage!({ type: "resync" });
    expect(o.onResync).not.toHaveBeenCalled();
  });

  it("reports a refused watch as an error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "invalid", message: "auto-refresh is off for the home folder" });
    const o = opts(true);
    renderHook(() => useWatch(o));
    await waitFor(() => expect(o.onError).toHaveBeenCalledWith("auto-refresh is off for the home folder"));
  });
});
