import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const channels = vi.hoisted(() => [] as { onmessage?: (e: unknown) => void }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "files_list_all") return { paths: [], capped: false, refused: false };
    if (cmd === "files_watch") return 1;
    if (cmd === "files_read") {
      return { kind: "text", text: "x", truncated: false, size: 1, mtime: 1 };
    }
    return [];
  }),
  Channel: class {
    onmessage?: (e: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
}));
import { useApp } from "../store/app";
import { setFolder } from "../workspaces/folder";
import { FilesOverlay } from "./FilesOverlay";
import { useFilesBus } from "./bus";
import { filesKey, useFiles } from "./store";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

describe("FilesOverlay", () => {
  beforeEach(() => {
    localStorage.clear();
    channels.length = 0;
    useFiles.setState(useFiles.getInitialState(), true);
    useFilesBus.setState(useFilesBus.getInitialState(), true);
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

  it("toggles heavy folders in the tree, hidden by default", async () => {
    render(<FilesOverlay />);
    const btn = screen.getByRole("button", { name: "Show heavy folders" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_list_dir", { machineId: "local", root: "/r", rel: "", showHeavy: true }),
    );
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

  describe("keys", () => {
    const key = filesKey(ref, "/r");
    const press = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
      act(() => {
        fireEvent.keyDown(window, { key: k, metaKey: true, ...extra });
      });
    const openTabs = async (...rels: string[]) => {
      for (const r of rels) useFiles.getState().open(key, r, { pin: true });
      render(<FilesOverlay />);
      await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain(rels[rels.length - 1]));
    };

    it("⌘W closes the active tab", async () => {
      await openTabs("a.ts", "b.ts");
      press("w");
      expect(useFiles.getState().ws(key).tabs).toEqual(["a.ts"]);
      expect(useFiles.getState().ws(key).active).toBe("a.ts");
    });

    it("⌘⇧] and ⌘⇧[ cycle the tabs", async () => {
      await openTabs("a.ts", "b.ts", "c.ts");
      press("}", { shiftKey: true, code: "BracketRight" });
      expect(useFiles.getState().ws(key).active).toBe("a.ts");
      press("{", { shiftKey: true, code: "BracketLeft" });
      expect(useFiles.getState().ws(key).active).toBe("c.ts");
    });

    it("⌘R reloads the lists and the open file", async () => {
      await openTabs("a.ts");
      await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "files_list_all")).toBe(true));
      const count = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd).length;
      const [lists, reads] = [count("files_list_all"), count("files_read")];
      press("r");
      await waitFor(() => expect(count("files_list_all")).toBe(lists + 1));
      await waitFor(() => expect(count("files_read")).toBe(reads + 1));
    });

    it("does nothing while a dialog is open over the overlay", async () => {
      await openTabs("a.ts", "b.ts");
      const dialog = document.createElement("div");
      dialog.className = "overlay";
      document.body.appendChild(dialog);
      press("w");
      expect(useFiles.getState().ws(key).tabs).toEqual(["a.ts", "b.ts"]);
      dialog.remove();
    });
  });

  describe("read errors and the watch", () => {
    const key = filesKey(ref, "/r");
    let prev: ReturnType<ReturnType<typeof vi.mocked<typeof invoke>>["getMockImplementation"]>;
    beforeEach(() => {
      prev = vi.mocked(invoke).getMockImplementation();
    });
    afterEach(() => {
      vi.mocked(invoke).mockImplementation(prev!);
      vi.useRealTimers();
    });

    const watch = () => channels[channels.length - 1];

    it("shows the folder missing when the watch reports the root removed", async () => {
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "changes", changes: [{ path: "", isDir: true, removed: true }] }));
      expect(await screen.findByText("This folder no longer exists.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
    });

    const listAlls = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_list_all").length;

    it("the first resync after opening does not list everything again", async () => {
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      await waitFor(() => expect(listAlls()).toBe(1));
      act(() => watch().onmessage!({ type: "resync" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(listAlls()).toBe(1);
    });

    it("a resync after the watch failed reloads, even the first one", async () => {
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      await waitFor(() => expect(listAlls()).toBe(1));
      act(() => watch().onmessage!({ type: "error", message: "ssh: connect failed" }));
      act(() => watch().onmessage!({ type: "resync" }));
      await waitFor(() => expect(listAlls()).toBe(2));
    });

    it("the first resync after coming back online reloads", async () => {
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "resync" }));
      const setState = (state: string) =>
        act(() => useApp.setState((s) => ({ machines: { local: { ...s.machines.local, state } } as never })));
      setState("disconnected");
      const before = channels.length;
      setState("connected");
      await waitFor(() => expect(channels.length).toBe(before + 1));
      vi.mocked(invoke).mockClear();
      act(() => watch().onmessage!({ type: "resync" }));
      await waitFor(() => expect(listAlls()).toBe(1));
    });

    it("a later resync reloads the lists and the open file", async () => {
      useFiles.getState().open(key, "a.ts", { pin: true });
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "resync" }));
      vi.mocked(invoke).mockClear();
      act(() => watch().onmessage!({ type: "resync" }));
      await waitFor(() => {
        const cmds = vi.mocked(invoke).mock.calls.map((c) => c[0]);
        expect(cmds).toContain("files_list_all");
        expect(cmds).toContain("files_read");
        expect(cmds).toContain("files_list_dir");
      });
    });

    it("shows and clears the auto-refresh error", async () => {
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "error", message: "upper limit on inotify watches reached!" }));
      expect(screen.getByRole("status").textContent).toBe("Auto-refresh stopped: upper limit on inotify watches reached!");
      act(() => watch().onmessage!({ type: "resync" }));
      expect(screen.queryByRole("status")).toBeNull();
    });
  });
});
