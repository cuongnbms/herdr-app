import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn().mockResolvedValue(undefined) }));
import { herdrCall } from "../lib/ipc";
import { useApp } from "../store/app";
import { getFolder, setFolder } from "../workspaces/folder";
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
    expect(within(items[3]).getByText("IDLE")).toBeTruthy();
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

  it("pins the pane's tab on double click", () => {
    useApp.setState({ agentTabs: { tabs: [], preview: null } });
    render(<AgentList />);
    fireEvent.doubleClick(screen.getByText("Guard export"));
    expect(useApp.getState().agentTabs).toEqual({ tabs: [{ machine_id: "local", session: "default", pane_id: "p2" }], preview: null });
  });

  it("shows a header per workspace with its folder, empty workspaces included", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w1" }, "/Users/me/checkout-api/");
    render(<AgentList />);
    const w1 = screen.getByRole("group", { name: "checkout-api" });
    // The folder name repeats the label, so only the tooltip carries it.
    expect(w1.querySelector(".ws-folder")).toBeNull();
    expect(w1.querySelector(".ws-head")?.getAttribute("title")).toBe("/Users/me/checkout-api/");
    expect(within(w1).getByText("Idempotent payments")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "web" })).getAllByRole("listitem")).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: "empty" })).getByText("no folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New agent in empty" })).toBeTruthy();
  });

  it("boxes the panes of a multi-pane tab together, leaving single-pane tabs bare", () => {
    render(<AgentList />);
    const tab = screen.getByRole("group", { name: "Tab release" });
    expect(tab.className).toContain("tab-group");
    expect(within(tab).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Tag v1.4.0"),
      expect.stringContaining("Ship flag"),
    ]);
    expect(screen.queryByRole("group", { name: "Tab ui" })).toBeNull();
    expect(screen.getByText("Guard export").closest(".tab-group")).toBeNull();
  });

  it("picks the agent from a menu under the header button", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w2" }, "/srv/web");
    render(<AgentList />);
    fireEvent.click(screen.getByRole("button", { name: "New agent in web" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["claude", "pi", "shell"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "claude" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", { workspace_id: "w2", cwd: "/srv/web", label: "claude", focus: false });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("starts in a pane's cwd and keeps it as the folder when none is stored", () => {
    render(<AgentList />);
    fireEvent.click(screen.getByRole("button", { name: "New agent in web" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "shell" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", { workspace_id: "w2", cwd: "/x", label: "shell", focus: false });
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w2" })).toBe("/x");
  });

  it("asks for a folder in the dialog when the workspace has none to offer", () => {
    render(<AgentList />);
    fireEvent.click(screen.getByRole("button", { name: "New agent in empty" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
    expect(screen.getByText("New agent in empty", { selector: "h3" })).toBeTruthy();
  });

  it("opens the new workspace dialog from the session header", () => {
    render(<AgentList />);
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeTruthy();
    expect(screen.getByText("New workspace in default", { selector: "h3" })).toBeTruthy();
  });

  it("offers no new workspace button on a stopped session", () => {
    useApp.setState({ machines: { local: { ...m, sessions: [{ ...m.sessions[0], running: false }] } } });
    render(<AgentList />);
    expect(screen.queryByRole("button", { name: "New workspace" })).toBeNull();
  });

  it("changes the folder from the header menu", () => {
    render(<AgentList />);
    fireEvent.contextMenu(screen.getByText("web", { selector: ".ws-label" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["New claude", "New pi", "New shell", "Browse files", "Change folder…", "Rename workspace…", "Close workspace"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Change folder…" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "/srv/web-app" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(within(screen.getByRole("group", { name: "web" })).getByText("web-app", { selector: ".ws-folder" })).toBeTruthy();
  });

  it("starts an agent from the header menu in the workspace folder", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w2" }, "/srv/web");
    render(<AgentList />);
    fireEvent.contextMenu(screen.getByText("web", { selector: ".ws-label" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New pi" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", { workspace_id: "w2", cwd: "/srv/web", label: "pi", focus: false });
  });

  it("offers pane and tab actions in the card menu", () => {
    render(<AgentList />);
    fireEvent.contextMenu(screen.getByText("Tag v1.4.0"));
    const names = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(names).toEqual(["Rename…", "Split right", "Split down", "Close pane", "New tab", "Rename tab…", "Close tab"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "pane.split", { target_pane_id: "p3", direction: "right" });
  });

  it("closes a pane from its card button without asking", () => {
    render(<AgentList />);
    fireEvent.click(screen.getByRole("button", { name: "Close Tag v1.4.0" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "pane.close", { pane_id: "p3" });
  });

  it("asks for a session when none is viewed", () => {
    useApp.setState({ viewed: null });
    render(<AgentList />);
    expect(screen.getByText("Select a session")).toBeTruthy();
  });
});

describe("AgentList tab reordering", () => {
  const dt = () => {
    const data: Record<string, string> = {};
    return { data, types: [] as string[], effectAllowed: "", dropEffect: "",
      setData(t: string, v: string) { data[t] = v; this.types.push(t); }, getData: (t: string) => data[t] ?? "", setDragImage() {} };
  };
  const card = (title: string) => screen.getByText(title).closest("button")!;
  const drag = (from: HTMLElement, to: HTMLElement) => {
    const dataTransfer = dt();
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragEnter(to, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    fireEvent.dragEnd(from, { dataTransfer });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({ machines: { local: m }, order: ["local"], selected: null, viewed: { machine_id: "local", session: "default" } });
  });

  it("moves a tab after the tab it is dropped on", () => {
    render(<AgentList />);
    // jsdom rects are empty, so every drop lands after the target.
    drag(card("Guard export"), card("Ship flag"));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.move", { tab_id: "w2:t1", insert_index: 2 });
    expect(document.querySelector(".drop-before, .drop-after")).toBeNull();
  });

  it("shows the indicator on the whole tab while dragging over one of its panes", () => {
    render(<AgentList />);
    const dataTransfer = dt();
    fireEvent.dragStart(card("Guard export"), { dataTransfer });
    fireEvent.dragOver(card("Tag v1.4.0"), { dataTransfer });
    expect(screen.getByRole("group", { name: "Tab release" }).className).toContain("drop-after");
  });

  it("does nothing when the drop leaves the tab in place", () => {
    render(<AgentList />);
    drag(card("Tag v1.4.0"), card("Ship flag"));
    drag(card("Guard export"), card("Guard export"));
    expect(herdrCall).not.toHaveBeenCalled();
  });

  it("refuses a drop on another workspace", () => {
    render(<AgentList />);
    drag(card("Idempotent payments"), card("Guard export"));
    expect(herdrCall).not.toHaveBeenCalled();
    expect(document.querySelector(".drop-before, .drop-after")).toBeNull();
  });
});
