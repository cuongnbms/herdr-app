import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
    expect(screen.getByLabelText("Terminal font")).toBeTruthy();
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
  it("changes and saves the terminal font family", () => {
    openSettings();
    fireEvent.change(screen.getByLabelText("Terminal font"), { target: { value: "Menlo" } });
    expect(useSettings.getState().terminalFontFamily).toBe("Menlo");
    expect(loadFonts().terminalFontFamily).toBe("Menlo");
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
