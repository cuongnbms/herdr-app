import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "./app";
import { syncSeenToHerdr } from "./seenSync";
import type { MachineView } from "../lib/types";

const machine = (status: "done" | "idle"): MachineView => ({
  id: "devtuf", label: "devtuf", kind: "ssh", state: "connected", error: null, version: "0.9.3", status,
  sessions: [{ name: "default", running: true, status, error: null, workspaces: [
    { workspace_id: "w1", label: "x", number: 1, status, tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status, panes: [
        { pane_id: "w1:p1", terminal_id: "t", title: "a", cwd: "/x", agent: "claude", status },
      ] },
    ] },
  ] }],
});
const ref = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };

describe("syncSeenToHerdr", () => {
  beforeEach(() => useApp.setState({ machines: {}, order: [], selected: null, dashboardOpen: false, doneSeen: {} }));

  it("focuses a done pane in herdr once the user looks at it", () => {
    const call = vi.fn(() => Promise.resolve());
    const stop = syncSeenToHerdr(call);
    useApp.getState().upsertMachine(machine("done"));
    expect(call).not.toHaveBeenCalled();
    useApp.getState().select(ref);
    expect(call).toHaveBeenCalledWith("devtuf", "default", "pane.focus", { pane_id: "w1:p1" });
    // Further snapshots while it is still done do not focus it again.
    useApp.getState().upsertMachine(machine("done"));
    expect(call).toHaveBeenCalledTimes(1);
    stop();
  });

  it("focuses the selected pane when it becomes done", () => {
    const call = vi.fn(() => Promise.resolve());
    const stop = syncSeenToHerdr(call);
    useApp.getState().upsertMachine(machine("idle"));
    useApp.getState().select(ref);
    expect(call).not.toHaveBeenCalled();
    useApp.getState().upsertMachine(machine("done"));
    expect(call).toHaveBeenCalledWith("devtuf", "default", "pane.focus", { pane_id: "w1:p1" });
    stop();
  });
});
