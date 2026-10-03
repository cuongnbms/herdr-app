import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({
  machineConnect: vi.fn().mockResolvedValue(undefined),
  sessionsRefresh: vi.fn().mockResolvedValue(undefined),
  sessionStart: vi.fn().mockRejectedValue({ code: "timeout", message: "session x did not start within 10s" }),
  sessionDelete: vi.fn().mockResolvedValue(undefined),
}));
import { machineConnect, sessionDelete, sessionsRefresh } from "../lib/ipc";
import { getFolder, setFolder } from "../workspaces/folder";
import { useApp } from "../store/app";
import { EMPTY_LAYOUT, sessionKey, useLayout } from "./groups";
import { Sidebar } from "./Sidebar";
import type { MachineView } from "../lib/types";

const local: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "unknown",
  sessions: [{ name: "x", running: false, status: "unknown", error: null, workspaces: [] }],
};
const set = (machines: MachineView[]) => {
  useLayout.setState({ layout: EMPTY_LAYOUT });
  useApp.setState({ machines: Object.fromEntries(machines.map((m) => [m.id, m])), order: machines.map((m) => m.id), selected: null, expanded: {} });
};

describe("Sidebar machine actions", () => {
  beforeEach(() => vi.clearAllMocks());
  it("offers Retry for the local machine in error", () => {
    set([{ ...local, state: "error", error: { code: "herdr_not_found", message: "herdr was not found" }, sessions: [] }]);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(machineConnect).toHaveBeenCalledWith("local");
  });
  it("offers Connect… for an ssh machine in a non-auth error", () => {
    set([{ ...local, id: "box", label: "box", kind: "ssh", state: "error", error: { code: "io", message: "Connection refused" }, sessions: [] }]);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    expect(machineConnect).toHaveBeenCalledWith("box");
  });
  it("refreshes sessions from the machine context menu, local included", () => {
    set([local]);
    render(<Sidebar />);
    fireEvent.contextMenu(within(screen.getByRole("region", { name: "Machines" })).getByText("local"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh sessions" }));
    expect(sessionsRefresh).toHaveBeenCalledWith("local");
  });
  it("shows a failed inline Start", async () => {
    set([local]);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Start x" }));
    expect((await screen.findByRole("alert")).textContent).toContain("did not start");
  });
  it("deletes a stopped session after confirming, and forgets its folders", async () => {
    set([local]);
    setFolder({ machine_id: "local", session: "x", workspace_id: "w1" }, "/srv/x");
    setFolder({ machine_id: "local", session: "xy", workspace_id: "w1" }, "/srv/xy");
    useLayout.setState({ layout: { tree: [], bookmarks: [sessionKey("local", "x")] } });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getAllByText("x")[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session…" }));
    expect(sessionDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(sessionDelete).toHaveBeenCalledWith("local", "x");
    await waitFor(() => expect(getFolder({ machine_id: "local", session: "x", workspace_id: "w1" })).toBeNull());
    expect(getFolder({ machine_id: "local", session: "xy", workspace_id: "w1" })).toBe("/srv/xy");
    expect(useLayout.getState().layout.bookmarks).toEqual([]);
  });
  it("offers no Delete for a running session", () => {
    set([{ ...local, sessions: [{ name: "x", running: true, status: "idle", error: null, workspaces: [] }] }]);
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("x"));
    expect(screen.queryByRole("menuitem", { name: "Delete session…" })).toBeNull();
  });
  it("bookmarks and unbookmarks a session from its menu", () => {
    set([local]);
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("x"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bookmark" }));
    expect(useLayout.getState().layout.bookmarks).toEqual([sessionKey("local", "x")]);
    fireEvent.contextMenu(screen.getAllByText("x")[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unbookmark" }));
    expect(useLayout.getState().layout.bookmarks).toEqual([]);
  });
  it("unbookmarking a session in a group keeps its group row", () => {
    set([local]);
    const kx = sessionKey("local", "x");
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "g", label: "Work", children: [{ kind: "session", key: kx }] }], bookmarks: [kx] } });
    render(<Sidebar />);
    expect(screen.getAllByText("x")).toHaveLength(2);
    fireEvent.contextMenu(within(screen.getByRole("region", { name: "Bookmarks" })).getByText("x"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unbookmark" }));
    expect(useLayout.getState().layout.bookmarks).toEqual([]);
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
    expect(screen.getAllByText("x")).toHaveLength(1);
    expect(screen.getByText("x").closest("li.group")?.textContent).toContain("Work");
  });
  it("creates, renames, nests and deletes groups", async () => {
    set([local]);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New group" }), { target: { value: " Work " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Work");
    fireEvent.contextMenu(screen.getByText("Work"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New subgroup" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New subgroup" }), { target: { value: "Sub" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByText("Sub")).closest("li.group")?.parentElement?.closest("li.group")?.textContent).toContain("Work");
    fireEvent.contextMenu(screen.getByText("Work"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename group" }), { target: { value: "Job" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByText("Job");
    fireEvent.contextMenu(screen.getByText("Job"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    await waitFor(() => expect(screen.queryByText("Job")).toBeNull());
    expect(screen.getByText("Sub")).toBeTruthy();
  });
});
