import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextView } from "./TextView";

describe("TextView", () => {
  it("saves the scroll position once, when the file is left, not on every scroll", () => {
    const save = vi.fn();
    const { container, rerender, unmount } = render(<TextView text={"a\nb\nc"} path="a.ts" initialScroll={0} saveScroll={save} find={null} />);
    const el = container.querySelector(".files-text") as HTMLElement;
    el.scrollTop = 40;
    fireEvent.scroll(el);
    el.scrollTop = 120;
    fireEvent.scroll(el);
    expect(save).not.toHaveBeenCalled();
    const saveB = vi.fn();
    rerender(<TextView text={"x"} path="b.ts" initialScroll={0} saveScroll={saveB} find={null} />);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("a.ts", 120);
    unmount();
    expect(saveB).toHaveBeenCalledWith("b.ts", 0);
  });
});
