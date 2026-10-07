import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showToast } from "../ui/Toast";
import { FileTree } from "./FileTree";

describe("FileTree", () => {
  it("loads lazily and opens files as preview or pinned", async () => {
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w1" onOpen={onOpen} reloadKey={0} />);
    fireEvent.click(await screen.findByText("a.md"));
    expect(onOpen).toHaveBeenLastCalledWith("a.md", false);
    fireEvent.doubleClick(screen.getByText("a.md"));
    expect(onOpen).toHaveBeenLastCalledWith("a.md", true);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(await screen.findByText("x.ts"));
    expect(onOpen).toHaveBeenLastCalledWith("src/x.ts", false);
  });

  it("shows a retry row when a folder fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "io", message: "Permission denied" });
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w2" onOpen={() => {}} reloadKey={0} />);
    expect(await screen.findByText("Could not list: Permission denied")).toBeTruthy();
    vi.mocked(invoke).mockResolvedValueOnce([{ name: "ok.md", kind: "file" }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("ok.md")).toBeTruthy());
  });

  it("refetches the root and expanded folders when reloadKey changes", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    const { rerender } = render(<FileTree machineId="local" root="/r" filesKey="local/default/w3" onOpen={() => {}} reloadKey={0} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("x.ts");
    const before = vi.mocked(invoke).mock.calls.length;
    rerender(<FileTree machineId="local" root="/r" filesKey="local/default/w3" onOpen={() => {}} reloadKey={1} />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(before + 2));
  });

  it("moves focus and expands with the keyboard", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w4" onOpen={onOpen} reloadKey={0} />);
    const src = (await screen.findByText("src")).closest("[role=treeitem]") as HTMLElement;
    src.focus();
    fireEvent.keyDown(src, { key: "ArrowRight" });
    await screen.findByText("x.ts");
    expect(src.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(src, { key: "ArrowDown" });
    const x = screen.getByText("x.ts").closest("[role=treeitem]") as HTMLElement;
    expect(document.activeElement).toBe(x);
    fireEvent.keyDown(x, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("src/x.ts", true);
    fireEvent.keyDown(x, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(src);
    fireEvent.keyDown(src, { key: "ArrowLeft" });
    expect(src.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands a linked folder like a folder", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "lib", kind: "dirlink" }] : [{ name: "y.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w5" onOpen={onOpen} reloadKey={0} />);
    const lib = (await screen.findByText("lib")).closest("[role=treeitem]") as HTMLElement;
    expect(lib.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(lib);
    fireEvent.click(await screen.findByText("y.ts"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith("lib/y.ts", false);
    lib.focus();
    fireEvent.keyDown(lib, { key: "ArrowLeft" });
    expect(lib.getAttribute("aria-expanded")).toBe("false");
  });

  it("double-clicking a folder toggles it once", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w6" onOpen={() => {}} reloadKey={0} />);
    const src = (await screen.findByText("src")).closest("[role=treeitem]") as HTMLElement;
    fireEvent.click(src, { detail: 1 });
    fireEvent.click(src, { detail: 2 });
    fireEvent.doubleClick(src);
    expect(src.getAttribute("aria-expanded")).toBe("true");
  });

  it("has one tab stop: the first item, then the last focused one", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => [{ name: "a.md", kind: "file" }, { name: "b.md", kind: "file" }]);
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w7" onOpen={() => {}} reloadKey={0} />);
    const a = (await screen.findByText("a.md")).closest("[role=treeitem]") as HTMLElement;
    const b = screen.getByText("b.md").closest("[role=treeitem]") as HTMLElement;
    expect([a.tabIndex, b.tabIndex]).toEqual([0, -1]);
    fireEvent.focus(b);
    expect([a.tabIndex, b.tabIndex]).toEqual([-1, 0]);
  });

  it("drops a collapsed folder's children on reload and lists it again when expanded", async () => {
    vi.mocked(invoke).mockReset();
    let gen = 0;
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: `x${gen}.ts`, kind: "file" }],
    );
    const { rerender } = render(<FileTree machineId="local" root="/r" filesKey="local/default/w8" onOpen={() => {}} reloadKey={0} />);
    const src = await screen.findByText("src");
    fireEvent.click(src);
    await screen.findByText("x0.ts");
    fireEvent.click(src, { detail: 1 });
    expect(screen.queryByText("x0.ts")).toBeNull();
    gen = 1;
    rerender(<FileTree machineId="local" root="/r" filesKey="local/default/w8" onOpen={() => {}} reloadKey={1} />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(3));
    fireEvent.click(screen.getByText("src"), { detail: 1 });
    expect(await screen.findByText("x1.ts")).toBeTruthy();
  });

  it("shows nothing of the old root while the new one loads", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.root === "/r" ? [{ name: "old.md", kind: "file" }] : new Promise(() => {}),
    );
    const { rerender } = render(<FileTree machineId="local" root="/r" filesKey="local/default/w9" onOpen={() => {}} reloadKey={0} />);
    await screen.findByText("old.md");
    rerender(<FileTree machineId="local" root="/s" filesKey="local/default/w9" onOpen={() => {}} reloadKey={0} />);
    expect(screen.queryByText("old.md")).toBeNull();
  });
  it("shows a chevron and folder icon on folders, a file icon on files", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [],
    );
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w10" onOpen={() => {}} reloadKey={0} />);
    const src = (await screen.findByText("src")).closest("[role=treeitem]") as HTMLElement;
    const a = screen.getByText("a.md").closest("[role=treeitem]") as HTMLElement;
    const icons = (el: HTMLElement) => [...el.querySelectorAll("svg")].map((s) => s.dataset.icon);
    expect(icons(src)).toEqual(["chevron", "folder"]);
    expect(icons(a)).toEqual(["file"]);
    fireEvent.click(src);
    await waitFor(() => expect(icons(src)).toEqual(["chevron", "folder-open"]));
    expect(src.classList.contains("open")).toBe(true);
  });
  it("copies a row's path or relative path from its context menu", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w11" onOpen={() => {}} reloadKey={0} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.contextMenu(await screen.findByText("x.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/r/src/x.ts"));
    expect(showToast).toHaveBeenLastCalledWith("Path copied");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Relative Path" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("src"));
    expect(showToast).toHaveBeenLastCalledWith("Relative path copied");
  });

  it("joins the path onto a filesystem root without doubling the slash", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => [{ name: "etc", kind: "dir" }]);
    render(<FileTree machineId="local" root="/" filesKey="local/default/w12" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("etc"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/etc"));
  });
});
