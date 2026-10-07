import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Outline, type Heading } from "./Outline";

const items: Heading[] = [
  { id: "a", level: 1, text: "A" },
  { id: "a1", level: 2, text: "A1" },
  { id: "a1x", level: 3, text: "A1x" },
  { id: "b", level: 1, text: "B" },
];

const names = () => screen.getAllByRole("listitem").map((li) => li.textContent);

describe("Outline", () => {
  it("lists every heading and marks the active one", () => {
    render(<Outline items={items} activeId="a1" onSelect={() => {}} />);
    expect(names()).toEqual(["A", "A1", "A1x", "B"]);
    expect(screen.getByText("A1").closest("li")?.getAttribute("aria-current")).toBe("true");
  });
  it("selects a heading on click", () => {
    const onSelect = vi.fn();
    render(<Outline items={items} activeId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("A1x"));
    expect(onSelect).toHaveBeenCalledWith("a1x");
  });
  it("collapsing a heading hides its subtree, not its siblings", () => {
    render(<Outline items={items} activeId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Collapse" })[0]);
    expect(names()).toEqual(["A", "B"]);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(names()).toEqual(["A", "A1", "A1x", "B"]);
  });
  it("the level buttons show headings down to that level", () => {
    render(<Outline items={items} activeId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show up to H2" }));
    expect(names()).toEqual(["A", "A1", "B"]);
    fireEvent.click(screen.getByRole("button", { name: "Show up to H1" }));
    expect(names()).toEqual(["A", "B"]);
    fireEvent.click(screen.getByRole("button", { name: "Show up to H3" }));
    expect(names()).toEqual(["A", "A1", "A1x", "B"]);
  });
});
