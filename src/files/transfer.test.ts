import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const revealItemInDir = vi.hoisted(() => vi.fn(async (_p: string) => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));
vi.mock("../ui/Toast", () => ({ showProgressToast: vi.fn(() => 7), updateToast: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { showProgressToast, updateToast } from "../ui/Toast";
import { startDownload, startUpload } from "./transfer";

describe("transfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads and reports the final names", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["a (1).md", "b.md"]);
    expect(await startUpload("m", "/r", "src", ["/Users/u/a.md", "/Users/u/b.md"])).toBe(true);
    expect(invoke).toHaveBeenCalledWith("files_upload", { machineId: "m", root: "/r", destRel: "src", sources: ["/Users/u/a.md", "/Users/u/b.md"] });
    expect(showProgressToast).toHaveBeenCalledWith("Uploading 2 items to src/…");
    expect(updateToast).toHaveBeenCalledWith(7, "Uploaded to src/: a (1).md, b.md", { alert: false });
  });

  it("names one item and the root", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["a.md"]);
    await startUpload("m", "/r", "", ["/Users/u/a.md"]);
    expect(showProgressToast).toHaveBeenCalledWith("Uploading a.md to /…");
  });

  it("reports a failed upload", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "io", message: "b.md already exists, try again" });
    expect(await startUpload("m", "/r", "", ["/Users/u/b.md"])).toBe(false);
    expect(updateToast).toHaveBeenCalledWith(7, "Upload failed: b.md already exists, try again");
  });

  it("does nothing for an empty pick", async () => {
    expect(await startUpload("m", "/r", "", [])).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(showProgressToast).not.toHaveBeenCalled();
  });

  it("downloads and offers Show in Finder", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("/Users/u/Downloads/x (1).md");
    await startDownload("m", "/r", "docs/x.md");
    expect(showProgressToast).toHaveBeenCalledWith("Downloading x.md…");
    const [id, text, opts] = vi.mocked(updateToast).mock.calls[0];
    expect([id, text]).toEqual([7, "Saved x (1).md"]);
    expect(opts?.action?.label).toBe("Show in Finder");
    opts?.action?.run();
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/u/Downloads/x (1).md");
  });

  it("reports a failed download", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "io", message: "tar: x.md: Cannot stat" });
    await startDownload("m", "/r", "x.md");
    expect(updateToast).toHaveBeenCalledWith(7, "Download failed: tar: x.md: Cannot stat");
  });
});
