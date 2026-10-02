import { describe, expect, it } from "vitest";
import type { MachineView, PaneView } from "../lib/types";
import { bucketCounts, bucketOf, dashboardCards, matchesQuery } from "./buckets";

const pane = (id: string, status: PaneView["status"], extra: Partial<PaneView> = {}): PaneView => ({
  pane_id: id, terminal_id: "t" + id, title: "pane " + id, cwd: "/x", agent: "claude", status, ...extra,
});

const machine = (id: string, panes: PaneView[], over: Partial<MachineView> = {}): MachineView => ({
  id, label: id + "-label", kind: id === "local" ? "local" : "ssh", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [
    { name: "default", running: true, status: "idle", error: null, workspaces: [
      { workspace_id: "w1", label: "herdr-app", number: 1, status: "idle", tabs: [
        { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes } ] } ] },
    { name: "old", running: false, status: "unknown", error: null, workspaces: [
      { workspace_id: "w9", label: "stale", number: 1, status: "idle", tabs: [
        { tab_id: "w9:t1", label: "1", number: 1, status: "idle", panes: [pane("z", "blocked")] } ] } ] },
  ],
  ...over,
});

describe("bucketOf", () => {
  it("puts blocked panes in Needs You and working in Working", () => {
    expect(bucketOf("blocked", false)).toBe("attention");
    expect(bucketOf("working", false)).toBe("working");
  });
  it("keeps done in Done until seen, then Idle", () => {
    expect(bucketOf("done", false)).toBe("done");
    expect(bucketOf("done", true)).toBe("idle");
  });
  it("treats idle and unknown as Idle", () => {
    expect(bucketOf("idle", false)).toBe("idle");
    expect(bucketOf("unknown", false)).toBe("idle");
  });
});

describe("dashboardCards", () => {
  it("lists panes of running sessions on connected machines with their bucket", () => {
    const machines = {
      local: machine("local", [pane("a", "blocked"), pane("b", "done"), pane("c", "done")]),
      box: machine("box", [pane("d", "working")], { state: "disconnected" }),
    };
    const cards = dashboardCards(machines, ["local", "box"], { "local/default/c": true });
    expect(cards.map((c) => [c.key, c.bucket])).toEqual([
      ["local/default/a", "attention"],
      ["local/default/b", "done"],
      ["local/default/c", "idle"],
    ]);
    expect(cards[0].ref).toEqual({ machine_id: "local", session: "default", pane_id: "a" });
    expect(cards[0].workspace.label).toBe("herdr-app");
    expect(cards[0].machine.label).toBe("local-label");
  });
  it("counts cards per bucket", () => {
    const cards = dashboardCards({ local: machine("local", [pane("a", "blocked"), pane("b", "working"), pane("c", "working")]) }, ["local"], {});
    expect(bucketCounts(cards)).toEqual({ attention: 1, working: 2, done: 0, idle: 0 });
  });
});

describe("matchesQuery", () => {
  const [card] = dashboardCards({ local: machine("local", [pane("a", "idle", { title: "Rewrite parser", agent: "pi" })]) }, ["local"], {});
  it("matches title, agent, workspace, session and machine case-insensitively", () => {
    for (const q of ["rewrite", "PI", "herdr-app", "default", "local-label", ""]) expect(matchesQuery(card, q)).toBe(true);
    expect(matchesQuery(card, "nope")).toBe(false);
  });
});
