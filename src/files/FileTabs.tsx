import { useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenu, type MenuItem } from "../sidebar/ContextMenu";
import { CloseIcon } from "../ui/icons";
import type { CloseScope } from "./store";

interface Props {
  tabs: string[];
  preview: string | null;
  active: string | null;
  onSelect(rel: string): void;
  onPin(rel: string): void;
  onClose(rel: string): void;
  onCloseTabs(scope: CloseScope, rel: string): void;
}

const basename = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

export function FileTabs({ tabs, preview, active, onSelect, onPin, onClose, onCloseTabs }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; rel: string } | null>(null);
  if (tabs.length === 0) return null;

  // Commands that would close nothing are left out.
  const menuItems = (rel: string): MenuItem[] => {
    const at = tabs.indexOf(rel);
    const items: MenuItem[] = [{ label: "Close", icon: CloseIcon, onSelect: () => onClose(rel) }];
    if (tabs.length > 1) items.push({ label: "Close Others", icon: CloseIcon, onSelect: () => onCloseTabs("others", rel) });
    if (at < tabs.length - 1) items.push({ label: "Close to the Right", icon: CloseIcon, onSelect: () => onCloseTabs("right", rel) });
    items.push({ label: "Close All", icon: CloseIcon, onSelect: () => onCloseTabs("all", rel) });
    return items;
  };

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
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, rel });
            }}
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
      {/* Out of the tablist, and fixed to the window rather than to an animating ancestor. */}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.rel)} onClose={() => setMenu(null)} />, document.body)}
    </div>
  );
}
