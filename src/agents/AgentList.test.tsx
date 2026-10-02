import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn().mockResolvedValue(undefined) }));
import { herdrCall } from "../lib/ipc";
import { useApp } from "../store/app";
import { setFolder } from "../workspaces/folder";
import { AgentList, workspaceGroups } from "./AgentList";
import type { MachineView, PaneView } from "../lib/types";

const pane = (id: string, title: string, agent: string | null, status: PaneView["status"]): PaneView => ({
  pane_id: id, terminal_id: "t" + id, title, cwd: "/x", agent, status,
});

const m: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "working",
  sessions: [
    { name: "default", running: true, status: "working", error: null, workspaces: [
      { workspace_id: "w1", label: "checkout-api", number: 1, status: "done", tabs: [
        { tab_id: "w1:t1", label: "1", number: 1, status: "done", panes: [pane("p1", "Idempotent payments", "claude", "done")] } ] },
      { workspace_id: "w2", label: "web", number: 2, status: "blocked", tabs: [
        { tab_id: "w2:t1", label: "ui", number: 1, status: "blocked", panes: [pane("p2", "Guard export", "codex", "blocked")] },
        { tab_id: "w2:t2", label: "release", number: 2, status: "idle", panes: [pane("p3", "Tag v1.4.0", null, "unknown"), pane("p4", "Ship flag", "pi", "idle")] } ] },
      { workspace_id: "w3", label: "empty", number: 3, status: "unknown", tabs: [] } ] },
    { name: "other", running: true, status: "idle", error: null, workspaces: [
      { workspace_id: "w9", label: "infra", number: 1, status: "idle", tabs: [
        { tab_id: "w9:t1", label: "1", number: 1, status: "idle", panes: [pane("p9", "Backup", "mystery", "working")] } ] } ] },
  ],
};

describe("workspaceGroups", () => {
  it("groups panes by workspace, naming the tab only when a workspace has several", () => {
    const groups = workspaceGroups(m.sessions[0]);
    expect(groups.map((g) => [g.workspace.workspace_id, g.entries.map((e) => [e.pane.pane_id, e.sub])])).toEqual([
      ["w1", [["p1", ""]]],
      ["w2", [["p2", "ui"], ["p3", "release"], ["p4", "release"]]],
      ["w3", []],
    ]);
  });
});

describe("AgentList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useApp.setState({ machines: { local: m }, order: ["local"], selected: null, viewed: { machine_id: "local", session: "default" } });
  });

  it("lists every pane of the viewed session with agent icon and status badge", () => {
    render(<AgentList />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByRole("img", { name: "claude" })).toBeTruthy();
    expect(within(items[0]).getByText("DONE")).toBeTruthy();
    expect(within(items[1]).getByRole("img", { name: "codex" })).toBeTruthy();
    expect(within(items[1]).getByText("INPUT")).toBeTruthy();
    expect(within(items[2]).getByRole("img", { name: "no agent" })).toBeTruthy();
    expect(within(items[3]).getByText("READY")).toBeTruthy();
  });

  it("falls back to a monogram for an unknown agent", () => {
    useApp.setState({ viewed: { machine_id: "local", session: "other" } });
    render(<AgentList />);
    expect(screen.getByRole("img", { name: "mystery" }).textContent).toBe("M");
    expect(screen.getByText("WORKING")).toBeTruthy();
  });

  it("selects a pane on click and marks it active", () => {
    render(<AgentList />);
    fireEvent.click(screen.getByText("Guard export"));
    expect(useApp.getState().selected).toEqual({ machine_id: "local", session: "default", pane_id: "p2" });
    expect(screen.getByText("Guard export").closest("button")?.className).toContain("active");
  });

  it("shows a header per workspace with its folder, empty workspaces included", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w1" }, "/Users/me/checkout-api/");
    render(<AgentList />);
    const w1 = screen.getByRole("group", { name: "checkout-api" });
    expect(within(w1).getByText("checkout-api", { selector: ".ws-folder" })).toBeTruthy();
    expect(within(w1).getByText("Idempotent payments")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "web" })).getAllByRole("listitem")).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: "empty" })).getByText("no folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New agent in empty" })).toBeTruthy();
  });

  it("opens the new agent dialog from the header button", () => {
    render(<AgentList />);
    fireEvent.click(screen.getByRole("button", { name: "New agent in web" }));
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
    expect(screen.getByText("New agent in web", { selector: "h3" })).toBeTruthy();
  });

  it("changes the folder from the header menu", () => {
    render(<AgentList />);
    fireEvent.contextMenu(screen.getByText("web", { selector: ".ws-label" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["New agent…", "Change folder…", "Rename workspace…", "Close workspace"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Change folder…" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/srv/web" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(within(screen.getByRole("group", { name: "web" })).getByText("web", { selector: ".ws-folder" })).toBeTruthy();
  });

  it("offers pane and tab actions in the card menu", () => {
    render(<AgentList />);
    fireEvent.contextMenu(screen.getByText("Tag v1.4.0"));
    const names = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(names).toEqual(["Rename…", "Split right", "Split down", "Close pane", "New tab", "Rename tab…", "Close tab"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "pane.split", { target_pane_id: "p3", direction: "right" });
  });

  it("asks for a session when none is viewed", () => {
    useApp.setState({ viewed: null });
    render(<AgentList />);
    expect(screen.getByText("Select a session")).toBeTruthy();
  });
});
