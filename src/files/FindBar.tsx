import { useEffect, useRef, type KeyboardEvent } from "react";

export function FindBar({
  count,
  index,
  focusKey = 0,
  query,
  matchCase,
  onQuery,
  onMatchCase,
  onStep,
  onClose,
}: {
  count: number;
  index: number;
  /** Changing it focuses the input again (⌘F while the bar is open). */
  focusKey?: number;
  query: string;
  matchCase: boolean;
  onQuery(q: string): void;
  onMatchCase(on: boolean): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      // Closes the find bar only; the overlay also listens for Esc.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="files-find">
      <input
        ref={input}
        className="files-find-input"
        value={query}
        placeholder="Find in file"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="files-find-case"
        title="Match case"
        aria-label="Match case"
        aria-pressed={matchCase}
        onClick={() => onMatchCase(!matchCase)}
      >
        Aa
      </button>
      <span className="files-find-count">{count > 0 ? `${index + 1} / ${count}` : "0 / 0"}</span>
    </div>
  );
}
