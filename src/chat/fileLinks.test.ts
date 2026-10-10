import { beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikePath, openInFiles, relUnderRoot } from "./fileLinks";
import { filesRead } from "../lib/ipc";
import { showToast } from "../ui/Toast";

const app = vi.hoisted(() => ({ openFile: vi.fn(), machineState: "connected" }));
vi.mock("../lib/ipc", () => ({ filesRead: vi.fn() }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../files/root", () => ({ panelRoot: () => ({ path: "/repo", source: "folder" }) }));
vi.mock("../store/app", () => ({
  useApp: { getState: () => ({ machines: { m: { state: app.machineState } }, selected: null, openFile: app.openFile }) },
  selectedPane: () => ({ workspace: { workspace_id: "w" }, pane: { cwd: "/repo" } }),
}));

describe("looksLikePath", () => {
  it("takes paths with a folder and a file extension", () => {
    expect(looksLikePath("docs/_draft/RASTER_SMOOTHING_COASTLINE_VI.md")).toBe(true);
    expect(looksLikePath("/home/me/app/src/main.rs")).toBe(true);
    expect(looksLikePath("./src/a.test.tsx")).toBe(true);
    expect(looksLikePath("../x/y.config")).toBe(true);
  });
  it("takes a bare file name only with a common extension", () => {
    expect(looksLikePath("README.md")).toBe(true);
    expect(looksLikePath("package.json")).toBe(true);
    expect(looksLikePath("console.log")).toBe(false);
    expect(looksLikePath("os.path")).toBe(false);
  });
  it("leaves out endpoints, versions, code and prose", () => {
    expect(looksLikePath("/point")).toBe(false);
    expect(looksLikePath("src/files")).toBe(false);
    expect(looksLikePath("1.0.0")).toBe(false);
    expect(looksLikePath("v1/2.0")).toBe(false);
    expect(looksLikePath("foo.bar()")).toBe(false);
    expect(looksLikePath("cat a.md")).toBe(false);
    expect(looksLikePath("https://x.io/a.md")).toBe(false);
    expect(looksLikePath("~/notes.md")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });
});

describe("relUnderRoot", () => {
  it("resolves a relative path against the cwd", () => {
    expect(relUnderRoot("docs/a.md", "/w/app", "/w/app")).toBe("docs/a.md");
    expect(relUnderRoot("./a.md", "/w/app/sub", "/w/app")).toBe("sub/a.md");
    expect(relUnderRoot("../b/a.md", "/w/app/sub", "/w/app")).toBe("b/a.md");
  });
  it("resolves a relative path against the root without a cwd", () => {
    expect(relUnderRoot("docs/a.md", null, "/w/app")).toBe("docs/a.md");
  });
  it("takes an absolute path below the root", () => {
    expect(relUnderRoot("/w/app/src/x.ts", "/elsewhere", "/w/app")).toBe("src/x.ts");
    expect(relUnderRoot("/w/app/src/x.ts", null, "/w/app/")).toBe("src/x.ts");
    expect(relUnderRoot("/etc/hosts.conf", null, "/")).toBe("etc/hosts.conf");
  });
  it("is null outside the root", () => {
    expect(relUnderRoot("/w/other/x.ts", null, "/w/app")).toBeNull();
    expect(relUnderRoot("/w/apple/x.ts", null, "/w/app")).toBeNull();
    expect(relUnderRoot("../x.ts", "/w/app", "/w/app")).toBeNull();
    expect(relUnderRoot("/w/app", null, "/w/app")).toBeNull();
  });
  it("reads a ~ root as the home folder of an absolute path", () => {
    expect(relUnderRoot("/home/me/app/a.md", null, "~/app")).toBe("a.md");
    expect(relUnderRoot("/Users/me/app/a.md", null, "~/app")).toBe("a.md");
    expect(relUnderRoot("/root/app/a.md", null, "~/app")).toBe("a.md");
    expect(relUnderRoot("/srv/app/a.md", null, "~/app")).toBeNull();
    expect(relUnderRoot("a.md", "/home/me/app", "~/app")).toBe("a.md");
  });
});

describe("openInFiles", () => {
  const pane = { machine_id: "m", session: "s", pane_id: "p" };
  beforeEach(() => {
    vi.clearAllMocks();
    app.machineState = "connected";
  });

  it("opens a file that is there", async () => {
    vi.mocked(filesRead).mockResolvedValue({ kind: "text", text: "", truncated: false } as never);
    await openInFiles(pane, "src/a.ts");
    expect(filesRead).toHaveBeenCalledWith("m", "/repo", "src/a.ts");
    expect(app.openFile).toHaveBeenCalledWith({ machine_id: "m", session: "s", workspace_id: "w" }, "/repo", "src/a.ts", { pin: false });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("toasts instead of opening a tab when the file is missing", async () => {
    vi.mocked(filesRead).mockRejectedValue({ code: "not_found", message: "no such file" });
    await openInFiles(pane, "src/gone.ts");
    expect(app.openFile).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("src/gone.ts does not exist");
  });

  it("still opens on other read errors, for the viewer to show", async () => {
    vi.mocked(filesRead).mockRejectedValue({ code: "io", message: "permission denied" });
    await openInFiles(pane, "src/a.ts");
    expect(app.openFile).toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("does not check a Machine that is not connected", async () => {
    app.machineState = "disconnected";
    await openInFiles(pane, "src/a.ts");
    expect(filesRead).not.toHaveBeenCalled();
    expect(app.openFile).toHaveBeenCalled();
  });
});
