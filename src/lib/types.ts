// Mirrors the Rust structs in src-tauri field-for-field (snake_case). Filled in by later tasks.

export interface PaneRef {
  machine_id: string;
  session: string;
  pane_id: string;
}

export interface AppError {
  code: string;
  message: string;
}

export function paneKey(ref: PaneRef): string {
  return `${ref.machine_id}/${ref.session}/${ref.pane_id}`;
}
