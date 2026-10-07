import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "files_list_all") return { paths: [], capped: false, refused: false };
    if (cmd === "files_changed") return { repo: false, total: 0, changes: [] };
    return [];
  }),
  Channel: class {},
}));
import { useApp } from "../store/app";
import { FilesOverlay } from "./FilesOverlay";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

describe("FilesOverlay", () => {
  beforeEach(() => {
    localStorage.clear();
    useApp.setState({
      machines: { local: { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, status: "idle", sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
        { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/r" }] }] },
      ] }] } } as never,
      filesOverlay: ref,
    });
  });

  it("shows the root from the pane and offers to save it as the workspace folder", () => {
    render(<FilesOverlay />);
    expect(screen.getByText("/r")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set as workspace folder" })).toBeTruthy();
    expect(screen.getByText("Open a file from the tree, or press ⌘P")).toBeTruthy();
  });

  it("Esc closes the overlay, but not while an input has focus", () => {
    render(<FilesOverlay />);
    screen.getByRole("combobox").focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().filesOverlay).not.toBeNull();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().filesOverlay).toBeNull();
  });

  it("shows Machine offline when the machine is not connected", () => {
    useApp.setState((s) => ({ machines: { local: { ...s.machines.local, state: "disconnected" } } as never }));
    render(<FilesOverlay />);
    expect(screen.getByText("Machine offline")).toBeTruthy();
  });

  it("Esc closes the overlay although a pane's textarea had focus before it opened", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    render(<FilesOverlay />);
    expect(document.activeElement).not.toBe(ta);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().filesOverlay).toBeNull();
    ta.remove();
  });

  it("Esc closes the overlay in the no-folder empty state", () => {
    useApp.setState((s) => ({
      machines: { local: { ...s.machines.local, sessions: [{ ...s.machines.local.sessions[0], workspaces: [{ ...s.machines.local.sessions[0].workspaces[0], tabs: [] }] }] } } as never,
    }));
    render(<FilesOverlay />);
    expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().filesOverlay).toBeNull();
  });

  it("offers Change folder… when the root does not exist", async () => {
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "files_list_all") throw { code: "not_found", message: "no such folder" };
      return [];
    }) as never);
    render(<FilesOverlay />);
    expect(await screen.findByRole("button", { name: "Change folder…" })).toBeTruthy();
    vi.mocked(invoke).mockImplementation(prev!);
  });
});
