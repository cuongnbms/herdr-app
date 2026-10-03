/**
 * An agent's todo list, read from the tool call's input. Adapted from herdr-web-ui's
 * `checklist.ts`: Claude Code's `TodoWrite` sends `todos: [{ content, status }]` and Codex's
 * `update_plan` sends `plan: [{ step, status }]`, both the whole list every time. The input is
 * a provider's transcript, not our type, so each entry is narrowed and a malformed one skipped.
 */

export type ChecklistStatus = "pending" | "in_progress" | "completed";

export interface ChecklistRow {
  label: string;
  status: ChecklistStatus;
}

const SHAPES = [["todos", "content"], ["plan", "step"]] as const;

function status(v: unknown): ChecklistStatus {
  return v === "completed" || v === "in_progress" ? v : "pending";
}

/** The list a todo call carries; null when the input is not a todo list. */
export function checklist(input: unknown): ChecklistRow[] | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  for (const [listKey, labelKey] of SHAPES) {
    const list = rec[listKey];
    if (!Array.isArray(list)) continue;
    return list.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const e = entry as Record<string, unknown>;
      const label = e[labelKey];
      return typeof label === "string" ? [{ label, status: status(e.status) }] : [];
    });
  }
  return null;
}

export function checklistSummary(rows: ChecklistRow[]): string {
  return `${rows.filter((r) => r.status === "completed").length}/${rows.length} done`;
}
