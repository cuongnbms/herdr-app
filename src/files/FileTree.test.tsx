import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "./FileTree";

describe("FileTree", () => {
  it("loads lazily and opens files as preview or pinned", async () => {
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" wsKey="local/default/w1" onOpen={onOpen} reloadKey={0} />);
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
    render(<FileTree machineId="local" root="/r" wsKey="local/default/w2" onOpen={() => {}} reloadKey={0} />);
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
    const { rerender } = render(<FileTree machineId="local" root="/r" wsKey="local/default/w3" onOpen={() => {}} reloadKey={0} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("x.ts");
    const before = vi.mocked(invoke).mock.calls.length;
    rerender(<FileTree machineId="local" root="/r" wsKey="local/default/w3" onOpen={() => {}} reloadKey={1} />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(before + 2));
  });

  it("moves focus and expands with the keyboard", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" wsKey="local/default/w4" onOpen={onOpen} reloadKey={0} />);
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
});
