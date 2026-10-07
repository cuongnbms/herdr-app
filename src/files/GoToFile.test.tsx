import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { GoToFile } from "./GoToFile";

describe("GoToFile", () => {
  it("opens the best match pinned on Enter", () => {
    const onOpen = vi.fn();
    render(<GoToFile list={{ paths: ["docs/tree.md", "src/a.ts"], capped: false, refused: false }} recent={[]} onOpen={onOpen} inputRef={createRef()} />);
    const input = screen.getByPlaceholderText(/^Go to file…\s+⌘P$/);
    fireEvent.change(input, { target: { value: "tree" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("docs/tree.md", true);
  });
  it("refused root disables the input; capped shows a hint", () => {
    const { rerender } = render(<GoToFile list={{ paths: [], capped: false, refused: true }} recent={[]} onOpen={() => {}} inputRef={createRef()} />);
    expect((screen.getByPlaceholderText("Too many files at this root") as HTMLInputElement).disabled).toBe(true);
    rerender(<GoToFile list={{ paths: ["a"], capped: true, refused: false }} recent={[]} onOpen={() => {}} inputRef={createRef()} />);
    expect(screen.getByText("First 50,000 files")).toBeTruthy();
  });
  it("Esc does not bubble to the overlay", () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><GoToFile list={{ paths: ["a"], capped: false, refused: false }} recent={[]} onOpen={() => {}} inputRef={createRef()} /></div>);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });
  it("ArrowDown selects the next result; a whitespace query shows recent files", () => {
    const onOpen = vi.fn();
    render(<GoToFile list={{ paths: ["a.ts", "b.ts"], capped: false, refused: false }} recent={["b.ts"]} onOpen={onOpen} inputRef={createRef()} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.getAllByRole("option")[0].textContent).toContain("b.ts");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect((input as HTMLInputElement).value).toBe("");
  });
});
