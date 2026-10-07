import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { HIGHLIGHT_LIMIT, POLL_MS } from "./limits";
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

  it("opens a small markdown file rendered and one over the highlight limit as source", async () => {
    texts["small.md"] = "# Small";
    texts["big.md"] = "# Big\n" + "x".repeat(HIGHLIGHT_LIMIT);
    const key = filesKey(ref, "/r");
    useFiles.getState().open(key, "small.md", { pin: true });
    render(<FilesOverlay />);
    expect(await screen.findByRole("heading", { name: "Small" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Render" }).getAttribute("aria-pressed")).toBe("true");
    act(() => useFiles.getState().open(key, "big.md", { pin: true }));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain("big.md"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("heading", { name: "Big" })).toBeNull();
    // Render stays one click away.
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(screen.getByRole("heading", { name: "Big" })).toBeTruthy();
  });

  it("a #L link to a markdown file opens it as source", async () => {
    texts["from.md"] = "[notes](notes.md#L2)";
    texts["notes.md"] = "# Notes\n\nsecond";
    useFiles.getState().open(filesKey(ref, "/r"), "from.md", { pin: true });
    render(<FilesOverlay />);
    fireEvent.click(await screen.findByText("notes"));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain("notes.md"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("heading", { name: "Notes" })).toBeNull();
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

    it("⌘F switches rendered markdown to Source and opens find; again refocuses it", async () => {
      texts["doc.md"] = "# Doc\n\nfoo";
      await openTabs("doc.md");
      await screen.findByRole("heading", { name: "Doc" });
      press("f");
      expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true");
      const input = screen.getByPlaceholderText("Find in file");
      expect(document.activeElement).toBe(input);
      input.blur();
      press("f");
      expect(document.activeElement).toBe(input);
    });

    it("Match case narrows the matches; ⌘G and ⇧⌘G step through them", async () => {
      texts["a.ts"] = "Foo foo\nfoo";
      await openTabs("a.ts");
      await waitFor(() => expect(document.querySelector(".files-text")).not.toBeNull());
      press("f");
      fireEvent.change(screen.getByPlaceholderText("Find in file"), { target: { value: "foo" } });
      const count = () => document.querySelector(".files-find-count")!.textContent;
      expect(count()).toBe("1 / 3");
      press("g");
      expect(count()).toBe("2 / 3");
      press("g");
      expect(count()).toBe("3 / 3");
      press("g", { shiftKey: true });
      expect(count()).toBe("2 / 3");
      fireEvent.click(screen.getByRole("button", { name: "Match case" }));
      expect(count()).toBe("1 / 2");
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

  describe("read errors and polling", () => {
    const key = filesKey(ref, "/r");
    let prev: ReturnType<ReturnType<typeof vi.mocked<typeof invoke>>["getMockImplementation"]>;
    beforeEach(() => {
      prev = vi.mocked(invoke).getMockImplementation();
    });
    afterEach(() => {
      vi.mocked(invoke).mockImplementation(prev!);
      vi.useRealTimers();
    });

    it("shows a read error in place of the file", async () => {
      vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
        if (cmd === "files_read") throw { code: "io", message: "permission denied" };
        return prev!(cmd, args as never);
      }) as never);
      useFiles.getState().open(key, "a.ts", { pin: true });
      render(<FilesOverlay />);
      expect((await screen.findByRole("alert")).textContent).toBe("permission denied");
    });

    it("keeps the file shown and adds a banner when a reload fails", async () => {
      useFiles.getState().open(key, "a.ts", { pin: true });
      const { container } = render(<FilesOverlay />);
      // The text view (jsdom lays out no rows of it).
      const shown = () => container.querySelector(".files-text");
      await waitFor(() => expect(shown()).toBeTruthy());
      vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
        if (cmd === "files_read") throw { code: "io", message: "timed out" };
        return prev!(cmd, args as never);
      }) as never);
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect((await screen.findByRole("alert")).textContent).toBe("Could not reload: timed out");
      expect(shown()).toBeTruthy();
    });

    it("shows File removed when polling finds the open file gone", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
        if (cmd === "files_stat") return [null];
        return prev!(cmd, args as never);
      }) as never);
      useFiles.getState().open(key, "a.ts", { pin: true });
      const { container } = render(<FilesOverlay />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      expect(screen.queryByText("File removed")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
      expect(screen.getByText("File removed")).toBeTruthy();
    });
  });
});
