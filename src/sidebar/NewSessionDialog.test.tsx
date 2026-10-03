import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ sessionStart: vi.fn() }));
import { sessionStart } from "../lib/ipc";
import { useApp } from "../store/app";
import { NewSessionDialog } from "./NewSessionDialog";

const create = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));
const name = (value: string) => fireEvent.change(screen.getByLabelText("Name"), { target: { value } });

describe("NewSessionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({ viewed: null });
  });

  it("starts the named session and opens it", async () => {
    vi.mocked(sessionStart).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewSessionDialog machineId="box" existing={["default"]} onClose={onClose} onError={() => {}} />);
    name(" api ");
    create();
    expect(onClose).toHaveBeenCalled();
    expect(sessionStart).toHaveBeenCalledWith("box", "api");
    await waitFor(() => expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "api" }));
  });

  it("rejects an invalid name without calling herdr", () => {
    render(<NewSessionDialog machineId="box" existing={[]} onClose={() => {}} onError={() => {}} />);
    for (const bad of ["", "-x", "a b", "a/b"]) {
      name(bad);
      create();
    }
    expect(sessionStart).not.toHaveBeenCalled();
    name("a b");
    expect(screen.getByRole("button", { name: "Create" })).toHaveProperty("disabled", true);
  });

  it("rejects a name the machine already has", () => {
    render(<NewSessionDialog machineId="box" existing={["api"]} onClose={() => {}} onError={() => {}} />);
    name("api");
    create();
    expect(sessionStart).not.toHaveBeenCalled();
    expect(screen.getByText(/already exists/)).toBeTruthy();
  });

  it("reports a failed start and opens nothing", async () => {
    vi.mocked(sessionStart).mockRejectedValue({ code: "timeout", message: "session api did not start within 10s" });
    const onError = vi.fn();
    render(<NewSessionDialog machineId="box" existing={[]} onClose={() => {}} onError={onError} />);
    name("api");
    create();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("session api did not start within 10s"));
    expect(useApp.getState().viewed).toBeNull();
  });
});
