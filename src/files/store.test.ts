import { beforeEach, describe, expect, it } from "vitest";
import { filesKey, useFiles, wsKey } from "./store";

const K = wsKey({ machine_id: "local", session: "default", workspace_id: "w1" });
const s = () => useFiles.getState().ws(K);

describe("files tabs", () => {
  beforeEach(() => useFiles.setState(useFiles.getInitialState(), true));

  it("previews replace each other; pinned stay", () => {
    const { open } = useFiles.getState();
    open(K, "a.ts", { pin: false });
    open(K, "b.ts", { pin: false });
    expect(s().tabs).toEqual(["b.ts"]);
    expect(s().preview).toBe("b.ts");
    open(K, "c.ts", { pin: true });
    open(K, "d.ts", { pin: false });
    expect(s().tabs).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(s().preview).toBe("d.ts");
    expect(s().active).toBe("d.ts");
  });

  it("pin keeps the preview tab", () => {
    const { open, pin } = useFiles.getState();
    open(K, "a.ts", { pin: false });
    pin(K, "a.ts");
    open(K, "b.ts", { pin: false });
    expect(s().tabs).toEqual(["a.ts", "b.ts"]);
  });

  it("closing the active tab activates the right neighbour, else the left", () => {
    const { open, close } = useFiles.getState();
    for (const f of ["a", "b", "c"]) open(K, f, { pin: true });
    useFiles.getState().open(K, "b", { pin: true });
    close(K, "b");
    expect(s().active).toBe("c");
    close(K, "c");
    expect(s().active).toBe("a");
    close(K, "a");
    expect(s().active).toBeNull();
  });

  it("cycles and records recent files newest first", () => {
    const { open, cycle } = useFiles.getState();
    for (const f of ["a", "b", "c"]) open(K, f, { pin: true });
    cycle(K, 1);
    expect(s().active).toBe("a");
    cycle(K, -1);
    expect(s().active).toBe("c");
    expect(s().recent.slice(0, 3)).toEqual(["c", "b", "a"]);
  });

  it("keeps workspaces apart", () => {
    const other = wsKey({ machine_id: "local", session: "default", workspace_id: "w2" });
    useFiles.getState().open(K, "a", { pin: true });
    expect(useFiles.getState().ws(other).tabs).toEqual([]);
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
    useFiles.getState().open(filesKey(ref, "/a"), "x.ts", { pin: true });
    expect(useFiles.getState().ws(filesKey(ref, "/b")).tabs).toEqual([]);
    expect(useFiles.getState().ws(filesKey(ref, "/a")).tabs).toEqual(["x.ts"]);
  });

  it("a pinned open of the current preview pins it in place", () => {
    const { open } = useFiles.getState();
    open(K, "a.ts", { pin: true });
    open(K, "b.ts", { pin: false });
    open(K, "b.ts", { pin: true });
    expect(s().tabs).toEqual(["a.ts", "b.ts"]);
    expect(s().preview).toBeNull();
    expect(s().active).toBe("b.ts");
    open(K, "c.ts", { pin: false });
    expect(s().tabs).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("closing the preview tab leaves no preview", () => {
    const { open, close } = useFiles.getState();
    open(K, "a.ts", { pin: true });
    open(K, "b.ts", { pin: false });
    close(K, "b.ts");
    expect(s()).toMatchObject({ tabs: ["a.ts"], preview: null, active: "a.ts" });
    open(K, "c.ts", { pin: false });
    expect(s().tabs).toEqual(["a.ts", "c.ts"]);
  });
});
