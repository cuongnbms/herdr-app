import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ sessionStart: vi.fn().mockResolvedValue(undefined) }));
import { sessionStart } from "../lib/ipc";
import { useApp } from "../store/app";
import { EMPTY_LAYOUT, sessionKey, useLayout } from "./groups";
import { Sidebar } from "./Sidebar";
import type { MachineView } from "../lib/types";

const m: MachineView = {
  id: "box", label: "devtuf", kind: "ssh", state: "connected", error: null, version: "0.9.3", status: "working",
  sessions: [
    { name: "default", running: true, status: "working", error: null, workspaces: [
      { workspace_id: "w1", label: "herdr-app", number: 1, status: "working", tabs: [
        { tab_id: "w1:t1", label: "1", number: 1, status: "working", panes: [
          { pane_id: "w1:p1", terminal_id: "t", title: "Rewrite", cwd: "/x", agent: "claude", status: "working" } ] } ] } ] },
    { name: "ai-radar", running: false, status: "unknown", error: null, workspaces: [] },
  ],
};
const row = (name: string) => screen.getAllByText(name)[0].closest("button")!;
const work = { kind: "group" as const, id: "g1", label: "Work", children: [{ kind: "session" as const, key: sessionKey("box", "default") }] };

describe("Sidebar", () => {
  beforeEach(() => {
    useApp.setState({ machines: { box: m }, order: ["box"], selected: null, viewed: null, expanded: {} });
    useLayout.setState({ layout: EMPTY_LAYOUT });
  });
  it("shows sessions with a machine badge and machines without sessions", () => {
    render(<Sidebar />);
    expect(row("default").querySelector(".badge-label")?.textContent).toBe("devtuf");
    expect(row("default").querySelector(".badge [aria-label='status working']")).toBeTruthy();
    expect(row("ai-radar").querySelector(".badge .dot")).toBeNull();
    const machines = screen.getByRole("region", { name: "Machines" });
    expect(within(machines).getByText("devtuf")).toBeTruthy();
    expect(within(machines).queryByText("default")).toBeNull();
    expect(screen.queryByText("herdr-app")).toBeNull();
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
  });
  it("renders sessions inside their group and collapses it", () => {
    useLayout.setState({ layout: { tree: [work], bookmarks: [] } });
    render(<Sidebar />);
    expect(row("default").closest("li.group")?.textContent).toContain("Work");
    fireEvent.click(screen.getByText("Work"));
    expect(useApp.getState().expanded["group:g1"]).toBe(false);
    expect(screen.queryByText("default")).toBeNull();
    expect(screen.getByText("ai-radar")).toBeTruthy();
  });
  it("shows a bookmarked session in Bookmarks and in its place", () => {
    useLayout.setState({ layout: { tree: [work], bookmarks: [sessionKey("box", "default")] } });
    render(<Sidebar />);
    const bm = screen.getByRole("region", { name: "Bookmarks" });
    expect(within(bm).getByText("default")).toBeTruthy();
    expect(screen.getAllByText("default")).toHaveLength(2);
  });
  it("views a running session on click", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("default"));
    expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "default" });
    expect(row("default").className).toContain("active");
  });
  it("marks both rows of a bookmarked session in a group active", () => {
    useLayout.setState({ layout: { tree: [work], bookmarks: [sessionKey("box", "default")] } });
    render(<Sidebar />);
    fireEvent.click(screen.getAllByText("default")[0]);
    const rows = screen.getAllByText("default").map((e) => e.closest("button")!);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => expect(r.className).toContain("active"));
  });
  it("selecting a pane views its session", () => {
    useApp.getState().select({ machine_id: "box", session: "default", pane_id: "w1:p1" });
    expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "default" });
  });
  it("starts and views a stopped session on click", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("ai-radar"));
    expect(sessionStart).toHaveBeenCalledWith("box", "ai-radar");
    await waitFor(() => expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "ai-radar" }));
  });
  it("ignores clicks on sessions of a machine that is not connected", () => {
    useApp.setState({ machines: { box: { ...m, state: "disconnected" } } });
    render(<Sidebar />);
    fireEvent.click(screen.getByText("default"));
    expect(useApp.getState().viewed).toBeNull();
    expect(row("default").getAttribute("aria-disabled")).toBe("true");
    fireEvent.contextMenu(screen.getByText("default"));
    expect(screen.getByRole("menuitem", { name: "Bookmark" })).toBeTruthy();
    for (const name of ["Delete session…", "Start session", "Stop session", "New workspace…"])
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
  });
});
