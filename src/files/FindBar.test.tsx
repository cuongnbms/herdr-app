import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FindBar } from "./FindBar";

const props = { count: 0, index: 0, query: "x", onQuery: () => {}, onStep: () => {}, onClose: () => {} };

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
});
