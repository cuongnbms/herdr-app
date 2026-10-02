import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AttachEvent, MachineView, PaneStatusEvent } from "./types";

export const machinesList = () => invoke<MachineView[]>("machines_list");
export const machineConnect = (id: string) => invoke<void>("machine_connect", { id });
export const machineDisconnect = (id: string) => invoke<void>("machine_disconnect", { id });
export const sessionsRefresh = (machineId: string) => invoke<void>("sessions_refresh", { machineId });
export const sessionStart = (machineId: string, session: string) =>
  invoke<void>("session_start", { machineId, session });
export const sessionStop = (machineId: string, session: string) =>
  invoke<void>("session_stop", { machineId, session });
export const herdrCall = <T>(machineId: string, session: string, method: string, params: unknown) =>
  invoke<T>("herdr_call", { machineId, session, method, params });

export const onMachine = (cb: (m: MachineView) => void): Promise<UnlistenFn> =>
  listen<MachineView>("sidebar://machine", (e) => cb(e.payload));
export const onPaneStatus = (cb: (e: PaneStatusEvent) => void): Promise<UnlistenFn> =>
  listen<PaneStatusEvent>("pane://status", (e) => cb(e.payload));

export interface AttachKey {
  machine_id: string;
  session: string;
  terminal_id: string;
}

export const attachKeyString = (k: AttachKey) => `${k.machine_id}/${k.session}/${k.terminal_id}`;

export const termOpen = (
  k: AttachKey,
  cols: number,
  rows: number,
  takeover: boolean,
  data: Channel<ArrayBuffer>,
  events: Channel<AttachEvent>,
) =>
  invoke<void>("term_open", {
    machineId: k.machine_id,
    session: k.session,
    terminalId: k.terminal_id,
    cols,
    rows,
    takeover,
    data,
    events,
  });
export const termWrite = (key: AttachKey, data: string) => invoke<void>("term_write", { key, data });
export const termResize = (key: AttachKey, cols: number, rows: number) =>
  invoke<void>("term_resize", { key, cols, rows });
export const termAck = (key: AttachKey, bytes: number) => invoke<void>("term_ack", { key, bytes });
export const termRelease = (key: AttachKey) => invoke<void>("term_release", { key });
export const termClose = (key: AttachKey) => invoke<void>("term_close", { key });
