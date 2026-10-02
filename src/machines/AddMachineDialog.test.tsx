import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({
  sshHosts: vi.fn().mockResolvedValue(["devtuf", "gpu-box"]),
  machineAdd: vi.fn().mockResolvedValue({ id: "devtuf" }),
  machineConnect: vi.fn().mockResolvedValue(undefined),
}));
import { machineAdd, machineConnect } from "../lib/ipc";
import { AddMachineDialog } from "./AddMachineDialog";

describe("AddMachineDialog", () => {
  it("suggests ssh hosts and adds + connects", async () => {
    const onClose = vi.fn();
    render(<AddMachineDialog onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "gpu-box" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("SSH target"), { target: { value: "devtuf" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(machineAdd).toHaveBeenCalledWith("devtuf", null, null));
    expect(machineConnect).toHaveBeenCalledWith("devtuf");
    expect(onClose).toHaveBeenCalled();
  });
});
