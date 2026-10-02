import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  systemFonts: vi.fn(async () => ["CaskaydiaCove Nerd Font Mono", "Lilex", "Menlo"]),
}));
import { Settings } from "./Settings";
import { DEFAULTS, loadFonts, useSettings } from "./store";

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ ...DEFAULTS });
});

function openSettings() {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("tab", { name: "Fonts" }));
}

describe("Settings dialog", () => {
  it("opens as a dialog on the General section and switches sections", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Fonts" }));
    expect(screen.getByRole("combobox", { name: "Terminal font" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Notifications" })).toBeNull();
  });

  it("closes on Escape and on the close button", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Settings fonts", () => {
  it("searches installed fonts and picks one with a click", async () => {
    openSettings();
    const box = screen.getByRole("combobox", { name: "Terminal font" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "lil" } });
    const option = await screen.findByRole("option", { name: "Lilex" });
    expect(screen.queryByRole("option", { name: "Menlo" })).toBeNull();
    fireEvent.mouseDown(option);
    expect(useSettings.getState().terminalFontFamily).toBe("Lilex");
    expect(loadFonts().terminalFontFamily).toBe("Lilex");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks the highlighted font with arrows and Enter", async () => {
    openSettings();
    const box = screen.getByRole("combobox", { name: "Terminal font" });
    fireEvent.focus(box);
    await screen.findByRole("option", { name: "Menlo" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useSettings.getState().terminalFontFamily).toBe("CaskaydiaCove Nerd Font Mono");
  });

  it("says when nothing matches, and Escape closes only the list", async () => {
    openSettings();
    const box = screen.getByRole("combobox", { name: "Terminal font" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(await screen.findByText("No matching fonts")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(useSettings.getState().terminalFontFamily).toBe("JetBrains Mono");
  });

  it("steps the terminal and chat sizes", () => {
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Increase terminal size" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease chat size" }));
    expect(useSettings.getState().terminalFontSize).toBe(14);
    expect(useSettings.getState().chatFontSize).toBe(12.5);
    expect(screen.getByText("14px")).toBeTruthy();
  });

  it("disables a stepper at its limit", () => {
    useSettings.setState({ terminalFontSize: 20 });
    openSettings();
    expect((screen.getByRole("button", { name: "Increase terminal size" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets fonts to defaults", () => {
    useSettings.getState().set({ terminalFontSize: 18, terminalFontFamily: "Menlo" });
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Reset fonts" }));
    expect(useSettings.getState()).toMatchObject(DEFAULTS);
  });
});
