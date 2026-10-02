import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../ui/Toast";
import { herdrCall } from "./ipc";

describe("herdrCall", () => {
  it("toasts on timeout and rethrows", async () => {
    (invoke as any).mockRejectedValueOnce({ code: "timeout", message: "x" });
    await expect(herdrCall("local", "default", "pane.read", {})).rejects.toMatchObject({ code: "timeout" });
    expect(showToast).toHaveBeenCalledWith("pane.read timed out");
  });
  it("does not toast other errors", async () => {
    (invoke as any).mockRejectedValueOnce({ code: "io", message: "x" });
    vi.mocked(showToast).mockClear();
    await expect(herdrCall("local", "default", "pane.read", {})).rejects.toBeTruthy();
    expect(showToast).not.toHaveBeenCalled();
  });
});
