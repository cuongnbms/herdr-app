import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn() }));
import { chatImage } from "../lib/ipc";
import { ChatImages, ChatPaneContext, revokeChatImages } from "./images";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const key = "devtuf/default/w1:p1";
const png = { ref: "u1:0", media_type: "image/png" };
let n = 0;
beforeEach(() => {
  revokeChatImages(key);
  vi.mocked(chatImage).mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn();
});
const show = (images = [png]) =>
  render(<ChatPaneContext.Provider value={pane}><ChatImages images={images} /></ChatPaneContext.Provider>);

describe("ChatImages", () => {
  it("shows a thumbnail from the bytes", async () => {
    show();
    const img = await screen.findByRole("img", { name: "Image 1" });
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(chatImage).toHaveBeenCalledWith(pane, "u1:0");
  });

  it("says when an image is unavailable", async () => {
    vi.mocked(chatImage).mockRejectedValueOnce({ code: "not_found", message: "image not available" });
    show();
    expect(await screen.findByText("Image unavailable")).toBeTruthy();
  });

  it("caches per pane and ref", async () => {
    const first = show();
    await screen.findByRole("img", { name: "Image 1" });
    first.unmount();
    show();
    await screen.findByRole("img", { name: "Image 1" });
    expect(chatImage).toHaveBeenCalledTimes(1);
    revokeChatImages(key);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("opens a viewer on click and closes it on Escape", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open image 1" }));
    expect(screen.getByRole("dialog", { name: "Image" })).toBeTruthy();
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders nothing outside a chat pane", () => {
    const { container } = render(<ChatImages images={[png]} />);
    expect(container.innerHTML).toBe("");
  });
});
