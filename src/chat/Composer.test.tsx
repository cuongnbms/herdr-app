import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({
  herdrCall: vi.fn().mockResolvedValue({}),
  imageSaveTemp: vi.fn(),
  completeCommands: vi.fn(),
  completeFiles: vi.fn(),
}));
import { completeCommands, completeFiles, herdrCall, imageSaveTemp } from "../lib/ipc";
import { Composer } from "./Composer";
import { clearCompletionCache } from "./useCompletions";
const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const png = () => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
const sendButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
const paste = (box: HTMLElement, files: File[], text = "") =>
  fireEvent.paste(box, { clipboardData: { files, getData: () => text } });

beforeEach(() => {
  vi.mocked(herdrCall).mockClear();
  vi.mocked(imageSaveTemp).mockReset().mockResolvedValue("/tmp/herdr-paste-1.png");
  clearCompletionCache();
  localStorage.clear();
  vi.mocked(completeCommands).mockReset().mockResolvedValue([
    { name: "clear", description: "Clear the conversation", source: "builtin" },
    { name: "compact", description: "Compact conversation context", source: "builtin" },
  ]);
  vi.mocked(completeFiles).mockReset().mockResolvedValue(["README.md", "src/x.ts", "src/y.ts", "my docs/a.md"]);
});

describe("Composer", () => {
  it("sends on Enter, newline on Shift+Enter", () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "fix the bug" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(herdrCall).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "fix the bug" });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
  it("sends Esc", () => {
    render(<Composer pane={pane} agent="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.send_keys", { target: "w1:p1", keys: ["esc"] });
  });

  it("saves a pasted image on the pane's machine and shows it as an attachment", async () => {
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    expect(sendButton().disabled).toBe(true);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(imageSaveTemp).toHaveBeenCalledWith("devtuf", expect.any(Uint8Array), "png");
    expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy();
  });

  it("pastes each image path for claude, then submits the text", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    paste(box, [png()]);
    fireEvent.change(box, { target: { value: "what is this" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    // The submit waits for Claude to attach the pasted image.
    expect(vi.mocked(herdrCall).mock.calls.map((c) => c[2])).toEqual(["pane.send_text"]);
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(vi.mocked(herdrCall).mock.calls).toEqual([
      ["devtuf", "default", "pane.send_text", { pane_id: "w1:p1", text: "\x1b[200~/tmp/herdr-paste-1.png\x1b[201~" }],
      ["devtuf", "default", "agent.prompt", { target: "w1:p1", text: "what is this" }],
    ]);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("submits images alone with Enter", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    paste(box, [png()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(vi.mocked(herdrCall).mock.calls.map((c) => c[2])).toEqual(["pane.send_text", "agent.send_keys"]);
    expect(herdrCall).toHaveBeenLastCalledWith("devtuf", "default", "agent.send_keys", { target: "w1:p1", keys: ["enter"] });
  });

  it("mentions image paths with @ for agents without path-paste attachments", async () => {
    render(<Composer pane={pane} agent="pi" />);
    const box = screen.getByRole("textbox");
    paste(box, [png()]);
    fireEvent.change(box, { target: { value: "describe" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(vi.mocked(herdrCall).mock.calls).toEqual([
      ["devtuf", "default", "agent.prompt", { target: "w1:p1", text: "@/tmp/herdr-paste-1.png describe" }],
    ]);
  });

  it("removes an attachment", async () => {
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    await waitFor(() => expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it("drops the attachment and reports a failed save", async () => {
    vi.mocked(imageSaveTemp).mockRejectedValue({ code: "not_found", message: "machine devtuf is not connected" });
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    expect((await screen.findByRole("alert")).textContent).toContain("machine devtuf is not connected");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("leaves text-only pastes to the textarea", () => {
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [], "hello");
    expect(imageSaveTemp).not.toHaveBeenCalled();
  });
});

const type = (box: HTMLElement, value: string) =>
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });

describe("Composer completion", () => {
  it("inserts the chosen slash command without sending and counts the pick", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    await screen.findByRole("option", { name: /\/clear/ });
    expect(completeCommands).toHaveBeenCalledWith(pane);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
    expect(herdrCall).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(JSON.parse(localStorage.getItem("herdr-app:slash-usage:claude")!)).toEqual({ compact: 1 });
  });

  it("dismisses with Escape, after which Enter sends", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "/c" });
  });

  it("completes a file path with Tab", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "look at @src/x");
    await screen.findByRole("option", { name: /src\/x\.ts/ });
    expect(completeFiles).toHaveBeenCalledWith(pane);
    fireEvent.keyDown(box, { key: "Tab" });
    expect((box as HTMLTextAreaElement).value).toBe("look at @src/x.ts ");
  });

  it("quotes a path with spaces", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "@my");
    await screen.findByRole("option", { name: /my docs\/a\.md/ });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe('@"my docs/a.md" ');
  });

  it("chooses a row with the mouse", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /\/compact/ }));
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
  });

  it("offers no slash commands to other agents", async () => {
    render(<Composer pane={pane} agent="gemini" />);
    type(screen.getByRole("textbox"), "/c");
    await act(async () => {});
    expect(completeCommands).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows a failed listing in the list and still sends on Enter", async () => {
    vi.mocked(completeFiles).mockRejectedValue({ code: "not_found", message: "machine devtuf is not connected" });
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "see @sr");
    expect(await screen.findByText("Couldn't list files")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "see @sr" });
  });
});
