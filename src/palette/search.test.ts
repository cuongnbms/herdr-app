import { describe, expect, it } from "vitest";
import { search } from "./search";
import type { MachineView } from "../lib/types";

const pane = (id: string, title: string, agent: string | null, status: any, cwd = "/x") => ({ pane_id: id, terminal_id: "t" + id, title, cwd, agent, status });
const m: MachineView = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "blocked", sessions: [
  { name: "default", running: true, status: "blocked", error: null, workspaces: [
    { workspace_id: "w1", label: "herdr-app", number: 1, status: "blocked", tabs: [{ tab_id: "w1:t1", label: "1", number: 1, status: "blocked", panes: [
      pane("w1:p1", "Rewrite UI", "claude", "working"), pane("w1:p2", "review", "pi", "blocked", "/srv/api"),
      pane("w1:p3", "idle one", null, "idle"), pane("w1:p4", "finished", "claude", "done"),
      pane("w1:p5", "Later work", "claude", "working"), pane("w1:p6", "idle two", "claude", "idle"),
      pane("w1:p7", "odd one", "claude", "unknown") ] }] } ] } ] };

describe("palette search", () => {
  it("matches title, agent, cwd and workspace", () => {
    expect(search([m], "rwui").map(h => h.ref.pane_id)).toEqual(["w1:p1"]);
    expect(search([m], "pi").map(h => h.ref.pane_id)).toContain("w1:p2");
    expect(search([m], "srv/api").map(h => h.ref.pane_id)).toEqual(["w1:p2"]);
    expect(search([m], "herdr-app")).toHaveLength(7);
  });
  it("ranks blocked, then done, then working, then idle, then the rest, and builds subtitles", () => {
    const hits = search([m], "");
    expect(hits.map(h => h.ref.pane_id)).toEqual(["w1:p2", "w1:p4", "w1:p1", "w1:p5", "w1:p3", "w1:p6", "w1:p7"]);
    expect(hits[0].subtitle).toBe("local › default › herdr-app");
  });
  it("puts the newest status change first within a status, then panes with no known time", () => {
    const since = { "local/default/w1:p3": 1_000, "local/default/w1:p6": 2_000, "local/default/w1:p5": 3_000 };
    expect(search([m], "", since).map(h => h.ref.pane_id)).toEqual(["w1:p2", "w1:p4", "w1:p5", "w1:p1", "w1:p6", "w1:p3", "w1:p7"]);
  });
});
