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
import { useFiles } from "./store";
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
});
