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
  beforeEach(() => { useApp.setState({ machines: { local: m }, order: ["local"], selected: null, viewed: null, expanded: {} }); });
  it("shows machines and sessions only; workspaces and panes live in the Agents column", () => {
    render(<Sidebar />);
    expect(screen.getByText("local")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
    expect(screen.queryByText("herdr-app")).toBeNull();
    expect(screen.queryByText("Rewrite")).toBeNull();
    expect(screen.getAllByLabelText("status working").length).toBeGreaterThan(0);
  });
  it("views a running session on click", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("default"));
    expect(useApp.getState().viewed).toEqual({ machine_id: "local", session: "default" });
    expect(screen.getByText("default").closest("button")?.className).toContain("active");
  });
  it("selecting a pane views its session", () => {
    useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w1:p1" });
    expect(useApp.getState().viewed).toEqual({ machine_id: "local", session: "default" });
  });
  it("offers to start a stopped session", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Start ai-radar" }));
    expect(sessionStart).toHaveBeenCalledWith("local", "ai-radar");
  });
});
