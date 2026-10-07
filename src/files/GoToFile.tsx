import { useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import type { FileList } from "../lib/types";
import { rankFiles } from "./fuzzy";
import { GOTO_RESULTS } from "./limits";

interface Props {
  list: FileList | null;
  recent: string[];
  onOpen: (rel: string, pin: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function GoToFile({ list, recent, onOpen, inputRef }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [focused, setFocused] = useState(false);
  const refused = list?.refused ?? false;
  const results = useMemo(
    () => (list && !refused ? rankFiles(query.trim(), list.paths, recent, GOTO_RESULTS) : []),
    [list, refused, query, recent],
  );
  // Only while focused: a list left open after blur covers the tree, and Esc would close the overlay.
  // Rows act on mousedown with preventDefault, so clicking one keeps the focus.
  const visible = results.length > 0 && focused;
  const active = Math.min(sel, Math.max(results.length - 1, 0));

  const choose = (rel: string) => {
    onOpen(rel, true);
    setQuery("");
    setSel(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!visible) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setSel((active + d + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (visible && results[active] !== undefined) choose(results[active]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setQuery("");
      setSel(0);
      e.currentTarget.blur();
    }
  };

  return (
    <div className="files-goto">
      <input
        ref={inputRef}
        className="files-goto-input"
        role="combobox"
        aria-expanded={visible}
        aria-controls="files-goto-list"
        aria-autocomplete="list"
        aria-activedescendant={visible ? `files-goto-${active}` : undefined}
        placeholder={refused ? "Too many files at this root" : "Go to file…  ⌘P"}
        disabled={refused}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSel(0);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        spellCheck={false}
        autoComplete="off"
      />
      {list?.capped && <div className="files-goto-hint">First 50,000 files</div>}
      {visible && (
        <ul className="files-goto-list" id="files-goto-list" role="listbox">
          {results.map((p, i) => (
            <li
              key={p}
              id={`files-goto-${i}`}
              role="option"
              aria-selected={i === active}
              className={`files-goto-item${i === active ? " sel" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
            >
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
