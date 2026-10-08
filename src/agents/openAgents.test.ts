import { describe, expect, it } from "vitest";
import { closeTabs, NO_TABS, openTab, pruneTabs, type AgentTabs } from "./openAgents";
import { paneKey, type MachineView, type PaneRef } from "../lib/types";

const r = (pane_id: string, session = "s", machine_id = "local"): PaneRef => ({ machine_id, session, pane_id });
const pinned = (...tabs: PaneRef[]): AgentTabs => ({ tabs, preview: null });
const pin = { pin: true };
const peek = { pin: false };

describe("agent tabs", () => {
  it("an unpinned open is the preview, replacing the previous preview in place", () => {
    let s = openTab(pinned(r("a")), r("b"), peek);
    expect(s).toEqual({ tabs: [r("a"), r("b")], preview: paneKey(r("b")) });
    s = openTab(openTab(s, r("c"), pin), r("d"), peek);
    expect(s).toEqual({ tabs: [r("a"), r("b"), r("c"), r("d")], preview: paneKey(r("d")) });
    s = openTab(pinned(r("a"), r("b")), r("x"), peek);
    s = openTab(s, r("x", "other"), peek);
    expect(s).toEqual({ tabs: [r("a"), r("b"), r("x", "other")], preview: paneKey(r("x", "other")) });
  });

  it("a pinned open of the preview pins it; an open tab is otherwise left alone", () => {
    const s = openTab(pinned(r("a")), r("b"), peek);
    expect(openTab(s, r("b"), pin)).toEqual(pinned(r("a"), r("b")));
    expect(openTab(s, r("a"), peek)).toBe(s);
    expect(openTab(s, r("a"), pin)).toBe(s);
  });

  it("a pinned open promotes the current preview", () => {
    const s = openTab(pinned(r("a")), r("b"), peek);
    expect(openTab(s, r("c"), pin)).toEqual(pinned(r("a"), r("b"), r("c")));
  });

  it("closes one tab, the others, those to the right, or all, forgetting a closed preview", () => {
    const s: AgentTabs = { tabs: [r("a"), r("b", "t"), r("c"), r("d")], preview: paneKey(r("d")) };
    expect(closeTabs(s, "one", r("b", "t"))).toEqual({ tabs: [r("a"), r("c"), r("d")], preview: paneKey(r("d")) });
    expect(closeTabs(s, "others", r("b", "t"))).toEqual(pinned(r("b", "t")));
    expect(closeTabs(s, "right", r("b", "t"))).toEqual(pinned(r("a"), r("b", "t")));
    expect(closeTabs(s, "all", r("b", "t"))).toEqual(NO_TABS);
    expect(closeTabs(s, "others", r("b"))).toBe(s);
  });

  it("drops the machine's panes its snapshot no longer has, keeping other machines' and an unchanged list", () => {
    const pane = (pane_id: string) => ({ pane_id, terminal_id: "t", title: pane_id, cwd: null, agent: "claude", status: "idle" as const });
    const v: MachineView = {
      id: "local", label: "local", kind: "local", state: "connected", error: null, version: "1", status: "idle",
      sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [
        { workspace_id: "w1", label: "w", number: 1, status: "idle", tabs: [
          { tab_id: "t1", label: "1", number: 1, status: "idle", panes: [pane("p1"), pane("p3")] },
        ] },
      ] }],
    };
    const remote = r("p2", "s", "devtuf");
    const s: AgentTabs = { tabs: [r("p1"), r("p2"), remote, r("p3"), r("p1", "gone")], preview: paneKey(r("p1", "gone")) };
    expect(pruneTabs(s, v)).toEqual(pinned(r("p1"), remote, r("p3")));
    const kept = pinned(r("p1"), r("p3"));
    expect(pruneTabs(kept, v)).toBe(kept);
  });
});
