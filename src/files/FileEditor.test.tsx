import { EditorView } from "@codemirror/view";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { languageSlot } from "./editorSetup";
import { draftKey, useDrafts } from "./drafts";
import { FileEditor } from "./FileEditor";

const key = draftKey("fk", "a.ts");
const open = (text: string) =>
  useDrafts.getState().open({ fk: "fk", machineId: "m", root: "/r", rel: "a.ts" }, { text, size: text.length, mtime: 1, cksum: 1 });
const viewOf = (c: HTMLElement) => EditorView.findFromDOM(c.querySelector(".cm-editor") as HTMLElement)!;
const hasLanguage = (v: EditorView) => {
  const ext = languageSlot.get(v.state);
  return !(Array.isArray(ext) && ext.length === 0);
};

describe("FileEditor", () => {
  beforeEach(() => useDrafts.setState(useDrafts.getInitialState(), true));

  it("shows the draft and writes edits back to it", () => {
    open("const a = 1;\n");
    const { container } = render(<FileEditor draftKey={key} />);
    expect(container.querySelector(".cm-content")?.textContent).toContain("const a = 1;");
    act(() => viewOf(container).dispatch({ changes: { from: 0, insert: "// hi\n" } }));
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: true });
    expect(useDrafts.getState().drafts[key].state.sliceDoc()).toBe("// hi\nconst a = 1;\n");
  });

  it("keeps the undo history across a remount and follows a reload from the store", () => {
    open("x\n");
    const first = render(<FileEditor draftKey={key} />);
    act(() => viewOf(first.container).dispatch({ changes: { from: 0, insert: "y" } }));
    first.unmount();
    const { container } = render(<FileEditor draftKey={key} />);
    expect(viewOf(container).state.sliceDoc()).toBe("yx\n");
    act(() => open("from disk\n"));
    expect(viewOf(container).state.sliceDoc()).toBe("from disk\n");
  });

  it("fills the language, and fills it again after the store replaces the state", async () => {
    open("const a = 1;\n");
    const { container } = render(<FileEditor draftKey={key} />);
    const view = viewOf(container);
    await waitFor(() => expect(hasLanguage(view)).toBe(true));
    expect(useDrafts.getState().drafts[key].state).toBe(view.state);

    act(() => open("let b = 2;\n"));
    await waitFor(() => expect(hasLanguage(view)).toBe(true));
    expect(view.state.sliceDoc()).toBe("let b = 2;\n");
    expect(useDrafts.getState().drafts[key].state).toBe(view.state);
    expect(useDrafts.getState().drafts[key].dirty).toBe(false);
  });
});
