import { beforeEach, describe, expect, it } from "vitest";
import { filesKey, useFiles, wsKey } from "./store";

const K = wsKey({ machine_id: "local", session: "default", workspace_id: "w1" });
const s = () => useFiles.getState().ws(K);

describe("files store", () => {
  beforeEach(() => useFiles.setState(useFiles.getInitialState(), true));

  it("records recent files newest first", () => {
    const { addRecent } = useFiles.getState();
    addRecent(K, "a");
    addRecent(K, "b");
    addRecent(K, "a");
    expect(s().recent).toEqual(["a", "b"]);
  });

  it("keeps workspaces apart", () => {
    const other = wsKey({ machine_id: "local", session: "default", workspace_id: "w2" });
    useFiles.getState().addRecent(K, "a");
    expect(useFiles.getState().ws(other).recent).toEqual([]);
  });

  it("toggles directories and remembers scroll", () => {
    const { toggleDir, setScroll } = useFiles.getState();
    toggleDir(K, "src");
    expect(s().expanded).toEqual(["src"]);
    toggleDir(K, "src");
    expect(s().expanded).toEqual([]);
    setScroll(K, "a", 42);
    expect(s().scroll).toEqual({ a: 42 });
  });

  it("keeps roots of one workspace apart", () => {
    const ref = { machine_id: "local", session: "default", workspace_id: "w1" };
    useFiles.getState().addRecent(filesKey(ref, "/a"), "x.ts");
    expect(useFiles.getState().ws(filesKey(ref, "/b")).recent).toEqual([]);
    expect(useFiles.getState().ws(filesKey(ref, "/a")).recent).toEqual(["x.ts"]);
  });

  it("moves a renamed item's folds, recent entry, scroll and mode, and those inside it", () => {
    const { toggleDir, addRecent, setScroll, setMode, moveRel } = useFiles.getState();
    toggleDir(K, "src");
    toggleDir(K, "src/x");
    toggleDir(K, "srcs");
    addRecent(K, "src/a.md");
    addRecent(K, "b.md");
    setScroll(K, "src/a.md", 7);
    setMode(K, "src/a.md", "source");
    moveRel(K, "src", "lib");
    expect(s().expanded).toEqual(["lib", "lib/x", "srcs"]);
    expect(s().recent).toEqual(["b.md", "lib/a.md"]);
    expect(s().scroll).toEqual({ "lib/a.md": 7 });
    expect(s().modes).toEqual({ "lib/a.md": "source" });
  });

  it("forgets a deleted item and what was inside it", () => {
    const { toggleDir, addRecent, setScroll, moveRel } = useFiles.getState();
    toggleDir(K, "src");
    addRecent(K, "src/a.md");
    addRecent(K, "b.md");
    setScroll(K, "src/a.md", 7);
    moveRel(K, "src", null);
    expect(s().expanded).toEqual([]);
    expect(s().recent).toEqual(["b.md"]);
    expect(s().scroll).toEqual({});
  });
});
