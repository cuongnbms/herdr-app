import { describe, expect, it } from "vitest";
import { canEdit, createEditorState, languageFor, roundTrips } from "./editorSetup";

const text = (t: string, over: Partial<{ editable: boolean; cksum: number | null }> = {}) => ({
  kind: "text" as const, text: t, truncated: false, size: t.length, mtime: 1, cksum: 7, editable: true, ...over,
});

describe("editorSetup", () => {
  it("keeps LF and CRLF files byte for byte", () => {
    for (const t of ["", "a", "a\nb\n", "a\r\nb\r\n", "a\r\nb", "\n\n"]) {
      expect(createEditorState(t).sliceDoc()).toBe(t);
      expect(roundTrips(t)).toBe(true);
    }
  });

  it("refuses mixed line endings and a lone CR", () => {
    expect(roundTrips("a\r\nb\nc")).toBe(false);
    expect(roundTrips("a\rb")).toBe(false);
  });

  it("can edit only editable text with a cksum that round-trips", () => {
    expect(canEdit(text("a\n"))).toBe(true);
    expect(canEdit(text("a\n", { editable: false }))).toBe(false);
    expect(canEdit(text("a\n", { cksum: null }))).toBe(false);
    expect(canEdit(text("a\r\nb\n"))).toBe(false);
    expect(canEdit({ kind: "binary", text: null, truncated: false, size: 3, mtime: 1, cksum: null, editable: false })).toBe(false);
  });

  it("finds a language by file name", async () => {
    expect(await languageFor("src/a.ts")).not.toBeNull();
    expect(await languageFor("README.md")).not.toBeNull();
    expect(await languageFor("notes.zzz")).toBeNull();
  });
});
