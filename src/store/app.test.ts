import { beforeEach, describe, expect, it } from "vitest";
import { chosenLens, useApp, selectedPane } from "./app";
import type { MachineView } from "../lib/types";

const machine: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "blocked",
  sessions: [{ name: "default", running: true, status: "blocked", error: null, workspaces: [
    { workspace_id: "w1", label: "herdr-app", number: 1, status: "blocked", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "blocked", panes: [
        { pane_id: "w1:p1", terminal_id: "term_a", title: "Rewrite", cwd: "/x", agent: "claude", status: "working" },
        { pane_id: "w1:p2", terminal_id: "term_b", title: "pi", cwd: "/x", agent: "pi", status: "blocked" },
      ] },
    ] },
  ] }],
};

describe("app store", () => {
  beforeEach(() => useApp.setState({ machines: {}, order: [], selected: null }));
  it("upserts machines keeping order", () => {
    useApp.getState().upsertMachine(machine);
    useApp.getState().upsertMachine({ ...machine, id: "devtuf", label: "devtuf", kind: "ssh" });
    useApp.getState().upsertMachine({ ...machine, status: "idle" });
    expect(useApp.getState().order).toEqual(["local", "devtuf"]);
    expect(useApp.getState().machines.local.status).toBe("idle");
  });
  it("resolves the selected pane path", () => {
    useApp.getState().upsertMachine(machine);
    useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w1:p2" });
    const sel = selectedPane(useApp.getState());
    expect(sel?.workspace.label).toBe("herdr-app");
    expect(sel?.pane.title).toBe("pi");
  });
  it("an automatic lens override is not persisted and an explicit choice clears it", () => {
    useApp.setState({ lens: {}, lensOverride: {} });
    useApp.getState().setLensOverride("k", "terminal");
    expect(chosenLens(useApp.getState(), "k")).toBe("terminal");
    expect(localStorage.getItem("herdr-app:ui") ?? "").not.toContain('"k"');
    useApp.getState().setLens("k", "chat");
    expect(useApp.getState().lensOverride).toEqual({});
    expect(chosenLens(useApp.getState(), "k")).toBe("chat");
    // The override wins over a remembered choice while it lasts.
    useApp.getState().setLensOverride("k", "terminal");
    expect(chosenLens(useApp.getState(), "k")).toBe("terminal");
  });
  it("returns null when the selected pane disappeared", () => {
    useApp.getState().upsertMachine(machine);
    useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w9:p9" });
    expect(selectedPane(useApp.getState())).toBeNull();
  });
});
