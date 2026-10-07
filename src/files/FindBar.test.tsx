import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FindBar } from "./FindBar";

const props = { count: 0, index: 0, query: "x", onQuery: () => {}, onStep: () => {}, onClose: () => {}, matchCase: false, onMatchCase: () => {} };

describe("FindBar", () => {
  it("takes the focus when opened and again when focusKey changes", () => {
    const other = document.createElement("button");
    document.body.appendChild(other);
    const { rerender } = render(<FindBar {...props} focusKey={0} />);
    const input = screen.getByPlaceholderText("Find in file");
    expect(document.activeElement).toBe(input);
    other.focus();
    rerender(<FindBar {...props} focusKey={0} />);
    expect(document.activeElement).toBe(other);
    rerender(<FindBar {...props} focusKey={1} />);
    expect(document.activeElement).toBe(input);
    other.remove();
  });
  it("toggles Match case", () => {
    const onMatchCase = vi.fn();
    const { rerender } = render(<FindBar {...props} onMatchCase={onMatchCase} />);
    const btn = screen.getByRole("button", { name: "Match case" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(onMatchCase).toHaveBeenCalledWith(true);
    rerender(<FindBar {...props} matchCase onMatchCase={onMatchCase} />);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(onMatchCase).toHaveBeenLastCalledWith(false);
  });
});
