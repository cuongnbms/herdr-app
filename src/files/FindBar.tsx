import { useEffect, useRef, type KeyboardEvent } from "react";

export function FindBar({
  count,
  index,
  query,
  onQuery,
  onStep,
  onClose,
}: {
  count: number;
  index: number;
  query: string;
  onQuery(q: string): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

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
      <span className="files-find-count">{count > 0 ? `${index + 1} / ${count}` : "0 / 0"}</span>
    </div>
  );
}
