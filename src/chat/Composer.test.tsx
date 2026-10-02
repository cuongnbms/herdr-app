import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn().mockResolvedValue({}) }));
import { herdrCall } from "../lib/ipc";
import { Composer } from "./Composer";
const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
describe("Composer", () => {
  it("sends on Enter, newline on Shift+Enter", () => {
    render(<Composer pane={pane} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "fix the bug" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(herdrCall).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "fix the bug" });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
  it("sends Esc", () => {
    render(<Composer pane={pane} />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.send_keys", { target: "w1:p1", keys: ["esc"] });
  });
});
