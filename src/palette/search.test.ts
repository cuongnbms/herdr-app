import { describe, expect, it } from "vitest";
import { search } from "./search";
import type { MachineView } from "../lib/types";

const pane = (id: string, title: string, agent: string | null, status: any, cwd = "/x") => ({ pane_id: id, terminal_id: "t" + id, title, cwd, agent, status });
const m: MachineView = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "blocked", sessions: [
  { name: "default", running: true, status: "blocked", error: null, workspaces: [
    { workspace_id: "w1", label: "herdr-app", number: 1, status: "blocked", tabs: [{ tab_id: "w1:t1", label: "1", number: 1, status: "blocked", panes: [
      pane("w1:p1", "Rewrite UI", "claude", "working"), pane("w1:p2", "review", "pi", "blocked", "/srv/api") ] }] } ] } ] };

describe("palette search", () => {
  it("matches title, agent, cwd and workspace", () => {
    expect(search([m], "rwui").map(h => h.ref.pane_id)).toEqual(["w1:p1"]);
    expect(search([m], "pi").map(h => h.ref.pane_id)).toContain("w1:p2");
    expect(search([m], "srv/api").map(h => h.ref.pane_id)).toEqual(["w1:p2"]);
    expect(search([m], "herdr-app")).toHaveLength(2);
  });
  it("ranks blocked panes first and builds subtitles", () => {
    const hits = search([m], "");
    expect(hits[0].ref.pane_id).toBe("w1:p2");
    expect(hits[0].subtitle).toBe("local › default › herdr-app");
  });
});
