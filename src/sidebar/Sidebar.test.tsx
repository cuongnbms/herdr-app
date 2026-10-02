import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ sessionStart: vi.fn().mockResolvedValue(undefined) }));
import { sessionStart } from "../lib/ipc";
import { useApp } from "../store/app";
import { Sidebar } from "./Sidebar";
import type { MachineView } from "../lib/types";

const m: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "working",
  sessions: [
    { name: "default", running: true, status: "working", error: null, workspaces: [
      { workspace_id: "w1", label: "herdr-app", number: 1, status: "working", tabs: [
        { tab_id: "w1:t1", label: "1", number: 1, status: "working", panes: [
          { pane_id: "w1:p1", terminal_id: "t", title: "Rewrite", cwd: "/x", agent: "claude", status: "working" } ] } ] } ] },
    { name: "ai-radar", running: false, status: "unknown", error: null, workspaces: [] },
  ],
};

describe("Sidebar", () => {
  beforeEach(() => { useApp.setState({ machines: { local: m }, order: ["local"], selected: null, expanded: {} }); });
  it("shows machine, sessions, workspace and pane; hides the single tab level", () => {
    render(<Sidebar />);
    expect(screen.getByText("local")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
    expect(screen.getByText("herdr-app")).toBeTruthy();
    expect(screen.getByText("Rewrite")).toBeTruthy();
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getAllByLabelText("status working").length).toBeGreaterThan(0);
  });
  it("selects a pane on click", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("Rewrite"));
    expect(useApp.getState().selected).toEqual({ machine_id: "local", session: "default", pane_id: "w1:p1" });
  });
  it("offers to start a stopped session", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Start ai-radar" }));
    expect(sessionStart).toHaveBeenCalledWith("local", "ai-radar");
  });
});
