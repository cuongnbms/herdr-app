import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatItemView } from "./ChatItemView";
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
  it("highlights fenced code", () => {
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: "```js\nconst a = 1;\n```" }} />);
    expect(container.querySelector("code.hljs, code .hljs-keyword")).toBeTruthy();
  });
});
