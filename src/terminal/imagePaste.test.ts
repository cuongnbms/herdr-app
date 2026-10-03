import { describe, expect, it, vi } from "vitest";
import { createImagePaste } from "./imagePaste";

function pasteEvent(files: File[], text = "") {
  const e = new Event("paste", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, "clipboardData", {
    value: { files, getData: (t: string) => (t === "text/plain" ? text : "") },
  });
  return e;
}

const png = () => new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

describe("createImagePaste", () => {
  it("saves a pasted image on the Machine and pastes its path", async () => {
    const save = vi.fn(() => Promise.resolve("/tmp/herdr-paste-1.png"));
    const paste = vi.fn();
    const e = pasteEvent([png()]);
    createImagePaste(save, paste, vi.fn())(e);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("/tmp/herdr-paste-1.png"));
    expect(save).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "png");
  });

  it("leaves a text paste to xterm", () => {
    const save = vi.fn();
    const e = pasteEvent([png()], "hello");
    createImagePaste(save, vi.fn(), vi.fn())(e);
    expect(e.defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves a paste without images to xterm", () => {
    const e = pasteEvent([new File(["x"], "a.txt", { type: "text/plain" })]);
    createImagePaste(vi.fn(), vi.fn(), vi.fn())(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("pastes several images in order, separated by spaces", async () => {
    let n = 0;
    const save = vi.fn(() => Promise.resolve(`/tmp/p${n++}.png`));
    const paste = vi.fn();
    createImagePaste(save, paste, vi.fn())(pasteEvent([png(), png()]));
    await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("/tmp/p0.png /tmp/p1.png"));
  });

  it("reports an unsupported type or a failed save", async () => {
    const fail = vi.fn();
    createImagePaste(vi.fn(), vi.fn(), fail)(pasteEvent([new File(["x"], "a.bmp", { type: "image/bmp" })]));
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("image/bmp"));
    const paste = vi.fn();
    createImagePaste(() => Promise.reject({ message: "ssh down" }), paste, fail)(pasteEvent([png()]));
    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith(expect.stringContaining("ssh down")));
    expect(paste).not.toHaveBeenCalled();
  });
});
