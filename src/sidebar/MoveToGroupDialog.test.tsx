import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store/app";
import { sessionKey, useLayout } from "./groups";
import { MoveToGroupDialog } from "./MoveToGroupDialog";
import type { MachineView } from "../lib/types";

const local: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "x", running: true, status: "idle", error: null, workspaces: [] }, { name: "y", running: true, status: "idle", error: null, workspaces: [] }],
};
const kx = sessionKey("local", "x");

describe("MoveToGroupDialog", () => {
  beforeEach(() => {
    useApp.setState({ machines: { local }, order: ["local"] });
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "a", label: "A", children: [{ kind: "group", id: "b", label: "B", children: [] }] }], bookmarks: [] } });
  });
  it("lists the root and group paths and moves the session", () => {
    const onClose = vi.fn();
    render(<MoveToGroupDialog sessionKey={kx} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "(root)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "A" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "A › B" }));
    const a = useLayout.getState().layout.tree[0];
    expect(a.kind === "group" && a.children[0].kind === "group" && a.children[0].children).toEqual([{ kind: "session", key: kx }]);
    expect(onClose).toHaveBeenCalled();
  });
});
