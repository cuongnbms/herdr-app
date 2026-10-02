import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MachineView, PaneStatusEvent } from "./types";

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
