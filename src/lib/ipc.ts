import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AttachEvent, MachineView, PaneStatusEvent } from "./types";

export const machinesList = () => invoke<MachineView[]>("machines_list");
export const machineConnect = (id: string) => invoke<void>("machine_connect", { id });
export const machineDisconnect = (id: string) => invoke<void>("machine_disconnect", { id });
export const sshHosts = () => invoke<string[]>("ssh_hosts");
export const machineAdd = (sshTarget: string, label: string | null, herdrPath: string | null) =>
  invoke<MachineView>("machine_add", { sshTarget, label, herdrPath });
export const machineRemove = (id: string) => invoke<void>("machine_remove", { id });
export const machineUpdate = (id: string, herdrPath: string | null) =>
  invoke<MachineView>("machine_update", { id, herdrPath });
export const machineMasterAlive = (id: string) => invoke<boolean>("machine_master_alive", { id });
export const connectOpen = (
  machineId: string,
  cols: number,
  rows: number,
  data: Channel<ArrayBuffer>,
  events: Channel<AttachEvent>,
) => invoke<void>("connect_open", { machineId, cols, rows, data, events });
export const connectWrite = (machineId: string, data: string) => invoke<void>("connect_write", { machineId, data });
export const connectResize = (machineId: string, cols: number, rows: number) =>
  invoke<void>("connect_resize", { machineId, cols, rows });
export const connectClose = (machineId: string) => invoke<void>("connect_close", { machineId });
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
