import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileTabs } from "./FileTabs";

describe("FileTabs", () => {
  const setup = () => {
    const h = { onSelect: vi.fn(), onPin: vi.fn(), onClose: vi.fn(), onCloseTabs: vi.fn() };
    render(<FileTabs tabs={["a/one.ts", "two.md"]} preview="two.md" active="a/one.ts" {...h} />);
    return h;
  };

  it("italicises the preview tab, pins on double click", () => {
    const h = setup();
    const tab = screen.getByRole("tab", { name: /two\.md/ });
    expect(tab.className).toContain("preview");
    expect(screen.getByRole("tab", { name: /one\.ts/ }).className).not.toContain("preview");
    fireEvent.doubleClick(tab);
    expect(h.onPin).toHaveBeenCalledWith("two.md");
  });

  it("closes on middle click and on the close button", () => {
    const h = setup();
    fireEvent(screen.getByRole("tab", { name: /one\.ts/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(h.onClose).toHaveBeenCalledWith("a/one.ts");
    fireEvent.click(screen.getByRole("button", { name: "Close two.md" }));
    expect(h.onClose).toHaveBeenCalledWith("two.md");
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("right click opens a menu of close commands for that tab", () => {
    const h = setup();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /one\.ts/ }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Close", "Close Others", "Close to the Right", "Close All"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close to the Right" }));
    expect(h.onCloseTabs).toHaveBeenCalledWith("right", "a/one.ts");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /one\.ts/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(h.onClose).toHaveBeenCalledWith("a/one.ts");
  });

  it("leaves out commands that would close nothing", () => {
    setup();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /two\.md/ }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Close", "Close Others", "Close All"]);
  });
});
