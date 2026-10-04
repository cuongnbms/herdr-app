import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ completeDirs: vi.fn() }));
import { completeDirs } from "../lib/ipc";
import { PathInput } from "./PathInput";

function Field({ initial = "", onEnter = () => {} }: { initial?: string; onEnter?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <PathInput machineId="devbox" aria-label="Folder" value={value} onChange={setValue}
      onKeyDown={(e) => e.key === "Enter" && onEnter()} />
  );
}

const input = () => screen.getByRole("combobox", { name: "Folder" }) as HTMLInputElement;

describe("PathInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(completeDirs).mockImplementation((_m, dir) =>
      Promise.resolve(dir === "/home/u" ? [".cache", "api", "Apps", "web"] : ["src"]));
  });

  it("lists the matching folders on the Machine as you type", async () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "/home/u/a" } });
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["api/", "Apps/"]));
    expect(completeDirs).toHaveBeenCalledWith("devbox", "/home/u");
  });

  it("completes the highlighted folder with Enter and lists its children", async () => {
    const onEnter = vi.fn();
    render(<Field onEnter={onEnter} />);
    fireEvent.change(input(), { target: { value: "/home/u/w" } });
    await screen.findByRole("option", { name: "web/" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input().value).toBe("/home/u/web/");
    expect(onEnter).not.toHaveBeenCalled();
    await screen.findByRole("option", { name: "src/" });
    expect(completeDirs).toHaveBeenCalledWith("devbox", "/home/u/web");
  });

  it("keeps a typed ~ and lets Enter through when nothing is highlighted", async () => {
    const onEnter = vi.fn();
    render(<Field onEnter={onEnter} />);
    fireEvent.change(input(), { target: { value: "~/" } });
    const option = await screen.findByRole("option", { name: "src/" });
    fireEvent.click(option);
    expect(input().value).toBe("~/src/");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onEnter).toHaveBeenCalled();
  });

  it("closes the dropdown on Escape without letting the dialog see it", async () => {
    const onDocKey = vi.fn();
    document.addEventListener("keydown", onDocKey);
    render(<Field initial="/home/u/" />);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    await screen.findByRole("option", { name: "api/" });
    onDocKey.mockClear();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onDocKey).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onDocKey).toHaveBeenCalled();
    document.removeEventListener("keydown", onDocKey);
  });

  it("stays closed when the field is focused with a prefilled path, until typing, ↓ or a click", async () => {
    render(<Field initial="/home/u/" />);
    fireEvent.focus(input());
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.mouseDown(input());
    await screen.findByRole("option", { name: "api/" });
  });

  it("shows no folders when the listing fails", async () => {
    vi.mocked(completeDirs).mockRejectedValue(new Error("ssh down"));
    render(<Field />);
    fireEvent.change(input(), { target: { value: "/nope/" } });
    await screen.findByText("No folders");
  });
});
