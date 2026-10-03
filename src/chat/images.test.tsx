import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn() }));
import { chatImage } from "../lib/ipc";
import { ChatImages, ChatOpenContext, ChatPaneContext, revokeChatImages } from "./images";

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

  it("keeps a loaded thumbnail when the pane is re-rendered as an equal new object", async () => {
    const ui = (p: typeof pane) =>
      <ChatPaneContext.Provider value={p}><ChatImages images={[png]} /></ChatPaneContext.Provider>;
    const { rerender } = render(ui(pane));
    await screen.findByRole("img", { name: "Image 1" });
    rerender(ui({ ...pane }));
    expect(screen.getByRole("img", { name: "Image 1" })).toBeTruthy();
    expect(chatImage).toHaveBeenCalledTimes(1);
  });

  it("shows a loaded thumbnail on first paint of a remount", async () => {
    const first = show();
    await screen.findByRole("img", { name: "Image 1" });
    first.unmount();
    show();
    expect(screen.getByRole("img", { name: "Image 1" })).toBeTruthy();
  });

  it("holds a placeholder box while an image is pending", () => {
    vi.mocked(chatImage).mockReturnValue(new Promise(() => {}));
    const { container } = show();
    expect(container.querySelector(".chat-image")).toBeTruthy();
  });

  it("retries a failed image when the chat is reopened, but not a loaded one", async () => {
    const gif = { ref: "u2:0", media_type: "image/gif" };
    vi.mocked(chatImage).mockImplementation((_, ref) =>
      ref === gif.ref ? Promise.reject({ code: "not_found", message: "no open chat for this pane" }) : Promise.resolve(new Uint8Array([1]).buffer));
    const ui = (opened: number) => (
      <ChatPaneContext.Provider value={pane}>
        <ChatOpenContext.Provider value={opened}><ChatImages images={[png, gif]} /></ChatOpenContext.Provider>
      </ChatPaneContext.Provider>
    );
    const { rerender } = render(ui(0));
    expect(await screen.findByText("Image unavailable")).toBeTruthy();
    await screen.findByRole("img", { name: "Image 1" });
    vi.mocked(chatImage).mockClear().mockResolvedValue(new Uint8Array([2]).buffer);
    rerender(ui(1));
    expect(await screen.findByRole("img", { name: "Image 2" })).toBeTruthy();
    expect(screen.queryByText("Image unavailable")).toBeNull();
    expect(chatImage).toHaveBeenCalledTimes(1);
    expect(chatImage).toHaveBeenCalledWith(pane, gif.ref);
  });

  it("renders the viewer under document.body", async () => {
    const { container } = show();
    fireEvent.click(await screen.findByRole("button", { name: "Open image 1" }));
    const dialog = screen.getByRole("dialog", { name: "Image" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});
