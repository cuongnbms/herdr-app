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

  it("starts a new search at the first match on screen and keeps that start while scrolling", () => {
    const text = Array.from({ length: 100 }, (_, i) => (i === 5 || i === 50 || i === 80 ? `foo ${i}` : `line ${i}`)).join("\n");
    const status = vi.fn();
    const props = { text, path: "a.ts", initialScroll: 0, saveScroll: () => {}, onFindStatus: status };
    const { container, rerender } = render(<TextView {...props} find={null} />);
    const el = container.querySelector(".files-text") as HTMLElement;
    // Line 40 is the first one wholly on screen at the default 20px line height.
    el.scrollTop = 40 * 20;
    rerender(<TextView {...props} find={{ query: "foo", index: 0, matchCase: false }} />);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 1 });
    el.scrollTop = 0;
    rerender(<TextView {...props} find={{ query: "foo", index: 1, matchCase: false }} />);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 2 });
    rerender(<TextView {...props} find={{ query: "foo", index: 2, matchCase: false }} />);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 0 });
    // A new query starts from the screen again: line 0 is on top now.
    rerender(<TextView {...props} find={{ query: "fo", index: 0, matchCase: false }} />);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 0 });
  });

  it("wraps to the first match when none is on screen or below it", () => {
    const text = Array.from({ length: 100 }, (_, i) => (i === 5 ? "foo" : "x")).join("\n");
    const status = vi.fn();
    const props = { text, path: "a.ts", initialScroll: 0, saveScroll: () => {}, onFindStatus: status };
    const { container, rerender } = render(<TextView {...props} find={null} />);
    (container.querySelector(".files-text") as HTMLElement).scrollTop = 60 * 20;
    rerender(<TextView {...props} find={{ query: "foo", index: 0, matchCase: false }} />);
    expect(status).toHaveBeenLastCalledWith({ count: 1, index: 0 });
  });
});
