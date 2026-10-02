import type { CSSProperties } from "react";
import { AgentIcon } from "./AgentIcon";

/** Agent picker as a segmented radio group; "none" shows the plain-shell prompt. */
export function AgentChoice<T extends string>({
  options,
  value,
  onChange,
  autoFocus = false,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  autoFocus?: boolean;
}) {
  const style = { "--n": options.length, "--i": options.indexOf(value) } as CSSProperties;
  return (
    <fieldset className="agent-choice">
      <legend>Agent</legend>
      <div className="seg" style={style}>
        <span className="seg-thumb" aria-hidden="true" />
        {options.map((a) => (
          <label key={a} className="seg-option">
            <input
              type="radio"
              name="agent"
              value={a}
              checked={value === a}
              autoFocus={autoFocus && value === a}
              onChange={() => onChange(a)}
            />
            <span aria-hidden="true"><AgentIcon agent={a === "none" ? null : a} /></span>
            {a}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
