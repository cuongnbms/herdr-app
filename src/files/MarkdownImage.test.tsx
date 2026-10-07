import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { MarkdownView } from "./MarkdownView";

const view = (text: string) =>
  render(<MarkdownView machineId="m1" root="/r" rel="docs/readme.md" text={text} onOpen={() => {}} initialScroll={0} saveScroll={() => {}} />);

describe("markdown images in the Files view", () => {
  // jsdom has no object URLs.
  const { createObjectURL, revokeObjectURL } = URL;
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it("loads a relative image from the Machine, resolved against the file", async () => {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));
    view("![logo](./img/a%20b.png)");
    const img = await screen.findByRole("img", { name: "logo" });
    expect(img.getAttribute("src")).toBe("blob:x");
    expect(invoke).toHaveBeenCalledWith("files_image", { machineId: "m1", root: "/r", rel: "docs/img/a b.png" });
  });

  it("shows the alt text when the image cannot be read", async () => {
    vi.mocked(invoke).mockRejectedValue({ message: "not found" });
    view("![logo](../missing.png)");
    await waitFor(() => expect(screen.getByText("logo").className).toContain("chat-image-link"));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("never loads a remote image or one outside the root", () => {
    view("![remote](https://example.com/a.png) ![out](../../a.png)");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link", { name: "remote" })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
