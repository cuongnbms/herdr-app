import { useEffect, useRef } from "react";
import type { SlashCommand } from "../lib/types";

export function CompletionMenu({
  kind,
  prefix,
  items,
  active,
  loading,
  error,
  onChoose,
}: {
  kind: "slash" | "file";
  prefix: "/" | "$";
  items: (SlashCommand | string)[];
  active: number;
  loading: boolean;
  error: boolean;
  onChoose: (i: number) => void;
}) {
  const activeRow = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const row = activeRow.current;
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  return (
    <ul role="listbox" aria-label={kind === "slash" ? "Slash commands" : "Files"} className="composer-menu">
      {items.map((item, i) => (
        <li
          key={typeof item === "string" ? item : item.name}
          ref={i === active ? activeRow : undefined}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onChoose(i);
          }}
        >
          <div className={`hit${i === active ? " active" : ""}`}>
            {typeof item === "string" ? <FileRow path={item} /> : <CommandRow command={item} prefix={prefix} />}
          </div>
        </li>
      ))}
      {items.length === 0 && loading && <li role="presentation" className="composer-menu-note">Loading…</li>}
      {items.length === 0 && error && (
        <li role="presentation" className="composer-menu-note">
          {kind === "slash" ? "Couldn't list commands" : "Couldn't list files"}
        </li>
      )}
    </ul>
  );
}

function CommandRow({ command, prefix }: { command: SlashCommand; prefix: "/" | "$" }) {
  return (
    <>
      <span className="composer-menu-name">
        {prefix}
        {command.name}
      </span>
      <span className="agent">{command.source}</span>
      <span className="composer-menu-desc">{command.description}</span>
    </>
  );
}

function FileRow({ path }: { path: string }) {
  const slash = path.lastIndexOf("/") + 1;
  return (
    <>
      <span className="composer-menu-dir">{path.slice(0, slash)}</span>
      <span className="composer-menu-name">{path.slice(slash)}</span>
    </>
  );
}
