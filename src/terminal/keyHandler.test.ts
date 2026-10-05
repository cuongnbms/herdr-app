import { describe, expect, it, vi } from "vitest";
import { createKeyHandler } from "./keyHandler";

const key = (type: string, init: KeyboardEventInit) => new KeyboardEvent(type, { cancelable: true, ...init });

describe("createKeyHandler", () => {
  it("leaves Cmd shortcuts to the app", () => {
    const send = vi.fn();
    expect(createKeyHandler(send)(key("keydown", { key: "c", keyCode: 67, metaKey: true }))).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("lets xterm handle ordinary keys", () => {
    const send = vi.fn();
    const handle = createKeyHandler(send);
    expect(handle(key("keydown", { key: "a", keyCode: 65 }))).toBe(true);
    expect(handle(key("keypress", { key: "A", charCode: 65, keyCode: 65 }))).toBe(true);
    expect(handle(key("keypress", { key: "ư", charCode: 432, keyCode: 432 }))).toBe(true);
    expect(handle(key("keypress", { key: "Enter", charCode: 13, keyCode: 13 }))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the whole text of a multi-character keypress (EVKey/OpenKey replacements)", () => {
    const send = vi.fn();
    const ev = key("keypress", { key: "ước", charCode: 432, keyCode: 432 });
    expect(createKeyHandler(send)(ev)).toBe(false);
    expect(send).toHaveBeenCalledWith("ước");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("leaves Ctrl and Option chords to xterm", () => {
    const send = vi.fn();
    const handle = createKeyHandler(send);
    expect(handle(key("keypress", { key: "ab", charCode: 97, ctrlKey: true }))).toBe(true);
    expect(handle(key("keypress", { key: "ab", charCode: 97, altKey: true }))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends Shift+Enter as a line feed, the new line key of Claude and pi", () => {
    const send = vi.fn();
    const handle = createKeyHandler(send);
    const down = key("keydown", { key: "Enter", keyCode: 13, shiftKey: true });
    expect(handle(down)).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(handle(key("keypress", { key: "Enter", charCode: 13, keyCode: 13, shiftKey: true }))).toBe(false);
    expect(handle(key("keyup", { key: "Enter", keyCode: 13, shiftKey: true }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\n");
  });

  it("leaves Shift+Enter with other modifiers to xterm", () => {
    const send = vi.fn();
    expect(createKeyHandler(send)(key("keydown", { key: "Enter", keyCode: 13, shiftKey: true, ctrlKey: true }))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends Home and End as Ctrl+A and Ctrl+E, the line start and end keys of zsh, Claude and pi", () => {
    const send = vi.fn();
    const handle = createKeyHandler(send);
    const home = key("keydown", { key: "Home", keyCode: 36 });
    expect(handle(home)).toBe(false);
    expect(home.defaultPrevented).toBe(true);
    expect(handle(key("keyup", { key: "Home", keyCode: 36 }))).toBe(true);
    expect(handle(key("keydown", { key: "End", keyCode: 35 }))).toBe(false);
    expect(send.mock.calls).toEqual([["\x01"], ["\x05"]]);
  });

  it("leaves Home and End with modifiers to xterm", () => {
    const send = vi.fn();
    const handle = createKeyHandler(send);
    expect(handle(key("keydown", { key: "Home", keyCode: 36, shiftKey: true }))).toBe(true);
    expect(handle(key("keydown", { key: "End", keyCode: 35, ctrlKey: true }))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});
