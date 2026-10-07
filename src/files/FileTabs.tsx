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
      {tabs.map((rel) => {
        const state = `${rel === active ? " active" : ""}${rel === preview ? " preview" : ""}`;
        return (
        // The tab and its close button are siblings: a tab must not contain another control.
        // Mouse gestures anywhere on the tab's box act on it.
        <div
          key={rel}
          role="none"
          title={rel}
          className={`files-tab-item${state}`}
          onClick={() => onSelect(rel)}
          onDoubleClick={() => onPin(rel)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(rel);
            }
          }}
        >
          <span
            role="tab"
            aria-selected={rel === active}
            tabIndex={rel === active ? 0 : -1}
            className={`files-tab${state}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(rel);
              }
            }}
          >
            <span className="files-tab-name">{basename(rel)}</span>
          </span>
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
        );
      })}
    </div>
  );
}
