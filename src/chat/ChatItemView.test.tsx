import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer) }));
import { ChatItemView } from "./ChatItemView";
import { ChatPaneContext } from "./images";
describe("ChatItemView", () => {
  it("renders markdown", () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "Hello **world**" }} />);
    expect(screen.getByText("world").tagName).toBe("STRONG");
  });
  it("collapses a tool call and expands to its result", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t1", name: "Bash", input_summary: "ls", input: { command: "ls" } }}
      result={{ kind: "tool_result", call_id: "t1", output: "a.txt", is_error: false }} />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.queryByText("a.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText("a.txt")).toBeTruthy();
  });
  it("marks a tool row with the tool's icon", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t1", name: "Bash", input_summary: "ls", input: { command: "ls" } }} />);
    const row = screen.getByRole("button", { name: /Bash/ });
    expect(row.querySelector("svg.chat-tool-icon")).toBeTruthy();
  });
  it("renders Edit as a diff", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t2", name: "Edit", input_summary: "/a.rs", input: { file_path: "/a.rs", old_string: "let a = 1;", new_string: "let a = 2;" } }} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByText("- let a = 1;")).toBeTruthy();
    expect(screen.getByText("+ let a = 2;")).toBeTruthy();
  });
  it("renders Write as all-added lines", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t3", name: "Write", input_summary: "/b.rs", input: { file_path: "/b.rs", content: "one\ntwo" } }} />);
    fireEvent.click(screen.getByRole("button", { name: /Write/ }));
    expect(screen.getByText("+ one")).toBeTruthy();
    expect(screen.getByText("+ two")).toBeTruthy();
  });
  it("renders MultiEdit as consecutive diffs", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t4", name: "MultiEdit", input_summary: "/c", input: { file_path: "/c", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } }} />);
    fireEvent.click(screen.getByRole("button", { name: /MultiEdit/ }));
    expect(screen.getByText("- c")).toBeTruthy();
    expect(screen.getByText("+ d")).toBeTruthy();
  });
  it("copies a user message and an answer's markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { unmount } = render(<ChatItemView item={{ kind: "user", text: "fix the bug" }} copy />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("fix the bug"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    unmount();
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "Done **now**" }} copy />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Done **now**"));
  });
  it("offers no copy unless asked (narration in a work block)", () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "Looking at the file" }} />);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
  it("highlights fenced code", () => {
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: "```js\nconst a = 1;\n```" }} />);
    expect(container.querySelector("code.hljs, code .hljs-keyword")).toBeTruthy();
  });
  it("shows a user turn's images above an image-only bubble", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    render(<ChatPaneContext.Provider value={{ machine_id: "m", session: "s", pane_id: "p" }}>
      <ChatItemView item={{ kind: "user", text: "", images: [{ ref: "u:0", media_type: "image/png" }] }} copy />
    </ChatPaneContext.Provider>);
    expect(await screen.findByRole("img", { name: "Image 1" })).toBeTruthy();
    expect(document.querySelector(".chat-bubble")).toBeNull();
  });
});
