import type { Changed } from "../lib/types";

interface Props {
  changed: Changed | null;
  onOpen: (rel: string, pin: boolean) => void;
}

function letter(code: string): string {
  if (code === "??") return "?";
  return code.trim()[0] ?? "";
}

export function ChangedList({ changed, onOpen }: Props) {
  if (!changed?.repo || changed.total === 0) return null;
  return (
    <div className="files-changed">
      <div className="files-changed-head">
        CHANGED ({changed.total}){changed.total > changed.changes.length && ` · first ${changed.changes.length}`}
      </div>
      {changed.changes.map((c) => (
        <button key={c.path} type="button" className="files-changed-row" onClick={() => onOpen(c.path, false)}>
          <span className="files-changed-code">{letter(c.code)}</span>
          <span className="files-changed-path">{c.path}</span>
        </button>
      ))}
    </div>
  );
}
