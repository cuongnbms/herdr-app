import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store/app";
import { Toasts } from "../ui/Toast";
import { FilesEntry } from "./FilesEntry";

const machines = {
  local: { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, status: "idle", sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/r" }] }] },
  ] }] },
} as never;

describe("FilesEntry", () => {
  beforeEach(() => useApp.setState({ machines, order: ["local"], selected: null, dashboardOpen: false, filesOverlay: null }));

  it("toasts with no selection", () => {
    render(<><FilesEntry /><Toasts /></>);
    fireEvent.click(screen.getByRole("button", { name: /browse files/i }));
    expect(screen.getByText("Select a workspace first")).toBeTruthy();
    expect(useApp.getState().filesOverlay).toBeNull();
  });

  it("toggles the Files overlay for the selected pane's Workspace, closing the dashboard", () => {
    useApp.setState({ selected: { machine_id: "local", session: "default", pane_id: "p1" }, dashboardOpen: true });
    render(<FilesEntry />);
    const btn = screen.getByRole("button", { name: /browse files/i });
    fireEvent.click(btn);
    expect(useApp.getState().filesOverlay).toMatchObject({ workspace_id: "w1" });
    expect(useApp.getState().dashboardOpen).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(useApp.getState().filesOverlay).toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });
});
