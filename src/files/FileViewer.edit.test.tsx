import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
const disk = vi.hoisted(() => ({ text: "one\n", cksum: 9, mtime: 1, editable: true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { text?: string }) => {
    if (cmd === "files_read") return { kind: "text", text: disk.text, truncated: false, size: disk.text.length, mtime: disk.mtime, cksum: disk.cksum, editable: disk.editable };
    if (cmd === "files_write") return { size: args!.text!.length, mtime: 2, cksum: 10 };
    return [];
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn(), showProgressToast: vi.fn(() => 1), updateToast: vi.fn() }));
import { useApp } from "../store/app";
import { itemKey } from "../store/openItems";
import { useFilesBus } from "./bus";
import { useDrafts } from "./drafts";
import { FileViewer } from "./FileViewer";
import { filesKey, useFiles } from "./store";
import { UnsavedDialog } from "./unsaved";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const item = { kind: "file" as const, ws, root: "/r", rel: "a.txt" };
const key = itemKey(item);
const press = (k: string, extra: Partial<KeyboardEventInit> = {}) => act(() => void fireEvent.keyDown(window, { key: k, ...extra }));
const typeAtEnd = (s: string) => {
  const v = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: s } }));
};
const writes = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_write");

describe("FileViewer edit mode", () => {
  beforeEach(() => {
    Object.assign(disk, { text: "one\n", cksum: 9, mtime: 1, editable: true });
    useFiles.setState(useFiles.getInitialState(), true);
    useFilesBus.setState(useFilesBus.getInitialState(), true);
    useApp.setState(useApp.getInitialState(), true);
    useDrafts.setState(useDrafts.getInitialState(), true);
    vi.mocked(invoke).mockClear();
  });

  it("Edit, type, ⌘S saves over the read version, Done leaves", async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(document.querySelector(".cm-editor")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    typeAtEnd("two\n");
    press("s", { metaKey: true });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1]).toMatchObject({ rel: "a.txt", text: "one\ntwo\n", expected: { size: 4, mtime: 1, cksum: 9 } });
    await waitFor(() => expect(useDrafts.getState().drafts[key].dirty).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.querySelector(".cm-editor")).toBeNull());
    expect(useDrafts.getState().drafts[key]).toBeUndefined();
  });

  it("Edit pins a preview tab, so opening another file as the preview keeps the Draft's tab", async () => {
    useApp.getState().openFile(ws, "/r", "a.txt", { pin: false });
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(useApp.getState().openItems.preview).toBeNull();
    act(() => useApp.getState().openFile(ws, "/r", "b.txt", { pin: false }));
    expect(useApp.getState().openItems.items.map(itemKey)).toEqual([key, itemKey({ ...item, rel: "b.txt" })]);
  });

  it("⌘⇧E enters, Esc with unsaved changes asks, Cancel stays", async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    await screen.findByRole("button", { name: "Edit" });
    press("e", { metaKey: true, shiftKey: true });
    expect(document.querySelector(".cm-editor")).toBeTruthy();
    typeAtEnd("x");
    press("Escape");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector(".cm-editor")).toBeTruthy();
  });

  it("Esc while the Unsaved dialog is open cancels it and neither asks again nor leaves Edit mode", async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    typeAtEnd("x");
    press("Escape");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    press("Escape");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Give a (wrong) second ask the time to open.
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".cm-editor")).toBeTruthy();
    expect(useDrafts.getState().drafts[key]?.dirty).toBe(true);
  });

  it("Esc that closes the editor's search panel does not leave Edit mode", async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // CodeMirror's search panel handles Esc first and prevents its default.
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault();
    act(() => void window.dispatchEvent(ev));
    expect(document.querySelector(".cm-editor")).toBeTruthy();
  });

  it("offers no Edit for a file that cannot be edited and a disabled one for mixed line endings", async () => {
    disk.editable = false;
    const { unmount } = render(<FileViewer item={item} online />);
    // The virtualised source view draws no rows in jsdom; the Copy contents button shows the file was read.
    await screen.findByRole("button", { name: "Copy contents" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    unmount();
    Object.assign(disk, { editable: true, text: "a\r\nb\nc" });
    render(<FileViewer item={item} online />);
    const edit = (await screen.findByRole("button", { name: "Edit" })) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("Mixed line endings");
  });

  it("keeps the draft when the viewer is remounted, as switching tabs does", async () => {
    const first = render(<FileViewer key="1" item={item} online />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    typeAtEnd("kept");
    first.unmount();
    render(<FileViewer key="2" item={item} online />);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("onekept"));
  });

  const publish = (changes: { path: string; isDir: boolean; removed: boolean }[]) =>
    act(() => useFilesBus.getState().publish(filesKey(ws, "/r"), changes));
  const startEditing = async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  };

  it("a clean draft follows the agent's write", async () => {
    await startEditing();
    Object.assign(disk, { text: "agent\n", cksum: 20, mtime: 5 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("agent"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a dirty draft is never replaced; a real change raises the banner, a touch does not", async () => {
    await startEditing();
    typeAtEnd("mine");
    disk.mtime = 7; // touched only: same cksum
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_read").length).toBe(2));
    expect(screen.queryByText("File changed on disk")).toBeNull();
    Object.assign(disk, { text: "agent\n", cksum: 21 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    expect(await screen.findByText("File changed on disk")).toBeTruthy();
    expect(document.querySelector(".cm-content")?.textContent).toContain("one" + "mine");
    press("s", { metaKey: true });
    expect(writes()).toHaveLength(0);
    expect(document.querySelector(".files-banner-conflict")?.classList.contains("flash")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1]).toMatchObject({ expected: null, text: "one\nmine" });
    await waitFor(() => expect(screen.queryByText("File changed on disk")).toBeNull());
  });

  it("Reload takes the disk version and drops the edits", async () => {
    await startEditing();
    typeAtEnd("mine");
    Object.assign(disk, { text: "agent\n", cksum: 22 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("agent"));
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, conflict: null, base: { cksum: 22 } });
  });

  it("the app's own save coming back from the watch raises nothing", async () => {
    await startEditing();
    typeAtEnd("two\n");
    let finish!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    press("s", { metaKey: true });
    Object.assign(disk, { text: "one\ntwo\n", cksum: 10, mtime: 2 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_read").length).toBe(2));
    await act(async () => finish({ size: 8, mtime: 2, cksum: 10 }));
    expect(screen.queryByText("File changed on disk")).toBeNull();
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, conflict: null });
  });

  it("a deleted file offers Save again and Close", async () => {
    await startEditing();
    typeAtEnd("mine");
    publish([{ path: "a.txt", isDir: false, removed: true }]);
    expect(await screen.findByText("File was deleted")).toBeTruthy();
    expect(screen.queryByText("File removed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save again" }));
    await waitFor(() => expect(writes()[0][1]).toMatchObject({ expected: null }));
  });

  it("the echo of the app's own save, arriving after it, leaves the editor state alone", async () => {
    await startEditing();
    typeAtEnd("two\n");
    press("s", { metaKey: true });
    await waitFor(() => expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, saving: false, gen: 1 }));
    const state = useDrafts.getState().drafts[key].state;
    Object.assign(disk, { text: "one\ntwo\n", cksum: 10, mtime: 2 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_read").length).toBe(2));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(useDrafts.getState().drafts[key].state).toBe(state);
    expect(useDrafts.getState().drafts[key].conflict).toBeNull();
  });

  it("a touch on a dirty draft refreshes the mtime so the next save is not a false conflict", async () => {
    await startEditing();
    typeAtEnd("mine");
    disk.mtime = 7;
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(useDrafts.getState().drafts[key].base.mtime).toBe(7));
    press("s", { metaKey: true });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1]).toMatchObject({ expected: { size: 4, mtime: 7, cksum: 9 } });
  });

  it("a failed read while the machine is offline is not a deletion", async () => {
    render(<FileViewer item={item} online={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    typeAtEnd("mine");
    vi.mocked(invoke).mockImplementationOnce(async () => {
      throw { code: "not_found", message: "machine local is not connected" };
    });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_read").length).toBe(2));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(screen.queryByText("File was deleted")).toBeNull();
    expect(useDrafts.getState().drafts[key].conflict).toBeNull();
  });

  it("a read that began before a save and lands after it is ignored", async () => {
    await startEditing();
    typeAtEnd("mine");
    let land!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => (land = r)));
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(land).toBeDefined());
    press("s", { metaKey: true });
    await waitFor(() => expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, saving: false }));
    const state = useDrafts.getState().drafts[key].state;
    await act(async () => land({ kind: "text", text: "one\n", truncated: false, size: 4, mtime: 1, cksum: 9, editable: true }));
    expect(screen.queryByText("File changed on disk")).toBeNull();
    expect(useDrafts.getState().drafts[key].state).toBe(state);
    expect(useDrafts.getState().drafts[key].base.cksum).toBe(10);
  });
});
