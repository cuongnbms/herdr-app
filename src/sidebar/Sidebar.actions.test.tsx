import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { Sidebar } from "./Sidebar";
import type { MachineView } from "../lib/types";

const local: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "unknown",
  sessions: [{ name: "x", running: false, status: "unknown", error: null, workspaces: [] }],
};
const set = (machines: MachineView[]) =>
  useApp.setState({ machines: Object.fromEntries(machines.map((m) => [m.id, m])), order: machines.map((m) => m.id), selected: null, expanded: {} });

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
    fireEvent.contextMenu(screen.getByText("local"));
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
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("x"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session…" }));
    expect(sessionDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(sessionDelete).toHaveBeenCalledWith("local", "x");
    await waitFor(() => expect(getFolder({ machine_id: "local", session: "x", workspace_id: "w1" })).toBeNull());
    expect(getFolder({ machine_id: "local", session: "xy", workspace_id: "w1" })).toBe("/srv/xy");
  });
  it("offers no Delete for a running session", () => {
    set([{ ...local, sessions: [{ name: "x", running: true, status: "idle", error: null, workspaces: [] }] }]);
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("x"));
    expect(screen.queryByRole("menuitem", { name: "Delete session…" })).toBeNull();
  });
});
