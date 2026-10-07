import { CloseIcon } from "../ui/icons";

interface Props {
  tabs: string[];
  preview: string | null;
  active: string | null;
  onSelect(rel: string): void;
  onPin(rel: string): void;
  onClose(rel: string): void;
}

const basename = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

export function FileTabs({ tabs, preview, active, onSelect, onPin, onClose }: Props) {
  if (tabs.length === 0) return null;
  return (
    <div className="files-tabs" role="tablist" aria-label="Open files">
      {tabs.map((rel) => (
        <div
          key={rel}
          role="tab"
          aria-selected={rel === active}
          tabIndex={rel === active ? 0 : -1}
          title={rel}
          className={`files-tab${rel === active ? " active" : ""}${rel === preview ? " preview" : ""}`}
          onClick={() => onSelect(rel)}
          onDoubleClick={() => onPin(rel)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(rel);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(rel);
            }
          }}
        >
          <span className="files-tab-name">{basename(rel)}</span>
          <button
            type="button"
            className="files-tab-close"
            aria-label={`Close ${rel}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(rel);
            }}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
