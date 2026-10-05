import { beforeEach, describe, expect, it } from "vitest";
import { chosenLens, useApp, selectedPane } from "./app";
import { paneKey } from "../lib/types";
import type { MachineView } from "../lib/types";
import { getFolder, setFolder } from "../workspaces/folder";
import { EMPTY_LAYOUT, sessionKey, useLayout } from "../sidebar/groups";
import { useLensSettings } from "../settings/lens";

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
  it("keeps the store untouched by an identical view", () => {
    useApp.getState().upsertMachine(machine);
    const before = useApp.getState();
    useApp.getState().upsertMachine(structuredClone(machine));
    const after = useApp.getState();
    expect(after.machines).toBe(before.machines);
    expect(after.doneSeen).toBe(before.doneSeen);
    expect(after.lensOverride).toBe(before.lensOverride);
  });
  it("reuses the unchanged parts of a changed view", () => {
    const two = structuredClone(machine);
    two.sessions[0].workspaces.push({ ...structuredClone(machine.sessions[0].workspaces[0]), workspace_id: "w2" });
    useApp.getState().upsertMachine(two);
    const prev = useApp.getState().machines.local;
    const next = structuredClone(two);
    next.sessions[0].workspaces[0].tabs[0].panes[1].status = "idle";
    useApp.getState().upsertMachine(next);
    const cur = useApp.getState().machines.local;
    expect(cur).not.toBe(prev);
    expect(cur.sessions[0].workspaces[0].tabs[0].panes[1].status).toBe("idle");
    expect(cur.sessions[0].workspaces[0].tabs[0].panes[0]).toBe(prev.sessions[0].workspaces[0].tabs[0].panes[0]);
    expect(cur.sessions[0].workspaces[1]).toBe(prev.sessions[0].workspaces[1]);
  });
  it("drops folders of workspaces that left a running session", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w1" }, "/x");
    setFolder({ machine_id: "local", session: "default", workspace_id: "w7" }, "/gone");
    useApp.getState().upsertMachine(machine);
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w1" })).toBe("/x");
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w7" })).toBeNull();
  });
  it("keeps the folder of a just-created workspace the snapshot does not list yet", () => {
    localStorage.clear();
    const w1 = { machine_id: "local", session: "default", workspace_id: "w1" };
    const w5 = { machine_id: "local", session: "default", workspace_id: "w5" };
    setFolder(w1, "/x");
    useApp.getState().upsertMachine(machine);
    setFolder(w5, "/srv/new");
    useApp.getState().upsertMachine({ ...machine, status: "idle" });
    expect(getFolder(w5)).toBe("/srv/new");
    expect(getFolder(w1)).toBe("/x");
    const s = machine.sessions[0];
    const w5View = { ...s.workspaces[0], workspace_id: "w5", tabs: [] };
    useApp.getState().upsertMachine({ ...machine, sessions: [{ ...s, workspaces: [w5View] }] });
    expect(getFolder(w1)).toBeNull();
    expect(getFolder(w5)).toBe("/srv/new");
  });
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

describe("done-seen tracking", () => {
  const withStatus = (p2: "done" | "working" | "blocked"): MachineView => {
    const s = machine.sessions[0];
    const ws = s.workspaces[0];
    const tab = ws.tabs[0];
    return { ...machine, sessions: [{ ...s, workspaces: [{ ...ws, tabs: [{ ...tab, panes: [tab.panes[0], { ...tab.panes[1], status: p2 }] }] }] }] };
  };
  const p2 = { machine_id: "local", session: "default", pane_id: "w1:p2" };
  beforeEach(() => useApp.setState({ machines: {}, order: [], selected: null, doneSeen: {}, dashboardOpen: false }));

  it("marks a done pane seen when it is selected", () => {
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({});
    useApp.getState().select(p2);
    expect(useApp.getState().doneSeen).toEqual({ "local/default/w1:p2": true });
  });
  it("marks the selected pane seen when it becomes done", () => {
    useApp.getState().upsertMachine(withStatus("working"));
    useApp.getState().select(p2);
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({ "local/default/w1:p2": true });
  });
  it("forgets the seen mark once the pane leaves done", () => {
    useApp.getState().upsertMachine(withStatus("done"));
    useApp.getState().select(p2);
    useApp.getState().select(null);
    useApp.getState().upsertMachine(withStatus("working"));
    expect(useApp.getState().doneSeen).toEqual({});
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({});
  });
  it("keeps other machines' seen marks", () => {
    useApp.setState({ doneSeen: { "devtuf/default/w1:p1": true } });
    useApp.getState().upsertMachine(withStatus("working"));
    expect(useApp.getState().doneSeen).toEqual({ "devtuf/default/w1:p1": true });
  });
  it("does not mark the selected pane seen while the dashboard hides it, only once it closes", () => {
    useApp.getState().upsertMachine(withStatus("working"));
    useApp.getState().select(p2);
    useApp.getState().setDashboardOpen(true);
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({});
    useApp.getState().setDashboardOpen(false);
    expect(useApp.getState().doneSeen).toEqual({ "local/default/w1:p2": true });
  });
  it("selecting a pane closes the dashboard", () => {
    useApp.getState().setDashboardOpen(true);
    useApp.getState().select(p2);
    expect(useApp.getState().dashboardOpen).toBe(false);
  });
  it("toggles the dashboard", () => {
    useApp.getState().setDashboardOpen(true);
    expect(useApp.getState().dashboardOpen).toBe(true);
    useApp.getState().setDashboardOpen(false);
    expect(useApp.getState().dashboardOpen).toBe(false);
  });
});

describe("layout pruning", () => {
  const sess = (name: string) => ({ name, running: false, status: "unknown" as const, error: null, workspaces: [] });
  const box = (state: MachineView["state"], ...names: string[]): MachineView => ({
    id: "box", label: "box", kind: "ssh", state, error: null, version: "0.9.3", status: "unknown", sessions: names.map(sess),
  });
  const placed = (...keys: string[]) => ({ tree: keys.map((key) => ({ kind: "session" as const, key })), bookmarks: [...keys] });
  const kept = () => useLayout.getState().layout.bookmarks;
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null });
    useLayout.setState({ layout: EMPTY_LAYOUT });
  });

  it("forgets sessions that left a connected machine since its previous view", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a"), sessionKey("box", "b")) });
    useApp.getState().upsertMachine(box("connected", "a", "b"));
    useApp.getState().upsertMachine(box("connected", "a"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
    expect(useLayout.getState().layout.tree).toEqual([{ kind: "session", key: sessionKey("box", "a") }]);
  });
  it("keeps everything on a first snapshot, even an empty one", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a")) });
    useApp.getState().upsertMachine(box("connected"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
  });
  it("does not prune for a machine that is not connected", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a")) });
    useApp.getState().upsertMachine(box("connected", "a"));
    useApp.getState().upsertMachine(box("disconnected"));
    useApp.getState().upsertMachine(box("error"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
  });
  it("forgets every session of a removed machine", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a"), sessionKey("local", "x")) });
    useApp.getState().upsertMachine(box("connected", "a"));
    useApp.getState().removeMachine("box");
    expect(kept()).toEqual([sessionKey("local", "x")]);
  });
});

describe("switching session", () => {
  const s = machine.sessions[0];
  const other = { ...s, name: "other", workspaces: [{ ...s.workspaces[0], workspace_id: "w2", tabs: [
    { ...s.workspaces[0].tabs[0], tab_id: "w2:t1", panes: [
      { ...s.workspaces[0].tabs[0].panes[0], pane_id: "w2:p1" },
      { ...s.workspaces[0].tabs[0].panes[1], pane_id: "w2:p2" },
    ] },
  ] }] };
  const empty = { ...s, name: "empty", workspaces: [] };
  const two: MachineView = { ...machine, sessions: [s, other, empty] };
  const pane = (session: string, pane_id: string) => ({ machine_id: "local", session, pane_id });
  beforeEach(() => useApp.setState({ machines: { local: two }, order: ["local"], selected: null, viewed: null, lastPane: {} }));

  it("opens the pane last selected in that session", () => {
    useApp.getState().select(pane("other", "w2:p2"));
    useApp.getState().select(pane("default", "w1:p1"));
    useApp.getState().view({ machine_id: "local", session: "other" });
    expect(useApp.getState().selected).toEqual(pane("other", "w2:p2"));
  });

  it("opens the session's first pane when none was selected there", () => {
    useApp.getState().select(pane("default", "w1:p2"));
    useApp.getState().view({ machine_id: "local", session: "other" });
    expect(useApp.getState().selected).toEqual(pane("other", "w2:p1"));
  });

  it("opens the first pane when the remembered one is gone", () => {
    useApp.setState({ lastPane: { "local/other": pane("other", "w2:p9") } });
    useApp.getState().view({ machine_id: "local", session: "other" });
    expect(useApp.getState().selected).toEqual(pane("other", "w2:p1"));
  });

  it("keeps the selection for a session without panes", () => {
    useApp.getState().select(pane("default", "w1:p1"));
    useApp.getState().view({ machine_id: "local", session: "empty" });
    expect(useApp.getState().selected).toEqual(pane("default", "w1:p1"));
    expect(useApp.getState().viewed).toEqual({ machine_id: "local", session: "empty" });
  });

  it("keeps the selection when viewing its own session", () => {
    useApp.getState().select(pane("default", "w1:p2"));
    useApp.getState().view({ machine_id: "local", session: "default" });
    expect(useApp.getState().selected).toEqual(pane("default", "w1:p2"));
  });
});

describe("an agent showing up in the selected pane", () => {
  const s = machine.sessions[0];
  const withAgent = (agent: string | null): MachineView => ({
    ...machine,
    sessions: [{ ...s, workspaces: [{ ...s.workspaces[0], tabs: [{ ...s.workspaces[0].tabs[0], panes: [
      { ...s.workspaces[0].tabs[0].panes[0], agent },
    ] }] }] }],
  });
  const ref = { machine_id: "local", session: "default", pane_id: "w1:p1" };
  const key = paneKey(ref);
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null, lens: {}, lensOverride: {} });
    useLensSettings.setState({ newAgentLens: "terminal" });
    useApp.getState().upsertMachine(withAgent(null));
    useApp.getState().select(ref);
  });

  it("keeps a shell pane on the Terminal lens when Claude starts in it", () => {
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBe("terminal");
  });

  it("leaves it to open on Chat when new agents open on Chat", () => {
    useLensSettings.setState({ newAgentLens: "chat" });
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBeUndefined();
  });

  it("leaves a lens the user picked", () => {
    useApp.getState().setLens(key, "chat");
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBe("chat");
  });

  it("does not touch panes that are not selected", () => {
    useApp.getState().select(null);
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBeUndefined();
  });
});
