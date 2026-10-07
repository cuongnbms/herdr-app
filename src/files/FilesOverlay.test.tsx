import { act, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
/** File texts that files_read answers with, by rel ("x" otherwise). */
const texts = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { rel?: string }) => {
    if (cmd === "files_list_all") return { paths: [], capped: false, refused: false };
    if (cmd === "files_changed") return { repo: false, total: 0, changes: [] };
    if (cmd === "files_read") {
      const text = texts[args?.rel ?? ""] ?? "x";
      return { kind: "text", text, truncated: false, size: text.length, mtime: 1 };
    }
    return [];
  }),
  Channel: class {},
}));
import { useApp } from "../store/app";
import { setFolder } from "../workspaces/folder";
import { FilesOverlay } from "./FilesOverlay";
import { filesKey, useFiles } from "./store";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

describe("FilesOverlay", () => {
  beforeEach(() => {
    localStorage.clear();
    useFiles.setState(useFiles.getInitialState(), true);
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

  it("does not call the root missing when the machine is disconnected", async () => {
    useApp.setState((s) => ({ machines: { local: { ...s.machines.local, state: "disconnected" } } as never }));
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "files_list_all") throw { code: "not_found", message: "machine local is not connected" };
      return [];
    }) as never);
    render(<FilesOverlay />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
    expect(screen.getByText("Machine offline")).toBeTruthy();
    vi.mocked(invoke).mockImplementation(prev!);
  });

  it("clears the missing state on reload once the root lists again", async () => {
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "files_list_all") throw { code: "not_found", message: "gone" };
      return [];
    }) as never);
    render(<FilesOverlay />);
    expect(await screen.findByRole("button", { name: "Change folder…" })).toBeTruthy();
    vi.mocked(invoke).mockImplementation(prev!);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByRole("combobox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
  });

  it("keeps the root it opened with; setting a folder re-resolves it and tabs follow their root", async () => {
    useFiles.getState().open(filesKey(ref, "/r"), "a.ts", { pin: true });
    render(<FilesOverlay />);
    expect(await screen.findByRole("tab", { name: /a\.ts/ })).toBeTruthy();
    // A cd in the pane does not move the open overlay.
    act(() =>
      useApp.setState((s) => ({
        machines: { local: { ...s.machines.local, sessions: [{ ...s.machines.local.sessions[0], workspaces: [{ ...s.machines.local.sessions[0].workspaces[0], tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/x" }] }] }] }] } } as never,
      })),
    );
    expect(screen.getByText("/r")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /a\.ts/ })).toBeTruthy();
    // Saving the same path as the workspace folder keeps the tabs.
    fireEvent.click(screen.getByRole("button", { name: "Set as workspace folder" }));
    expect(screen.queryByRole("button", { name: "Set as workspace folder" })).toBeNull();
    expect(screen.getByRole("tab", { name: /a\.ts/ })).toBeTruthy();
    // Another folder is another root, with tabs of its own.
    act(() => setFolder(ref, "/new"));
    expect(screen.getByText("/new")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});
