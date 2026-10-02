export type BannerKind = "held" | "exited" | "detached";

interface Props {
  kind: BannerKind;
  code?: number | null;
  onTakeOver: () => void;
  onReattach: () => void;
}

export function Banner({ kind, code, onTakeOver, onReattach }: Props) {
  if (kind === "held") {
    return (
      <div className="term-banner" role="status">
        <span>This terminal is attached elsewhere.</span>
        <button onClick={onTakeOver}>Take over</button>
      </div>
    );
  }
  if (kind === "exited") {
    return (
      <div className="term-banner" role="status">
        <span>Process exited{code != null ? ` (code ${code})` : ""}</span>
      </div>
    );
  }
  return (
    <div className="term-banner" role="status">
      <span>Disconnected. Waiting for the machine to reconnect…</span>
      <button onClick={onReattach}>Reattach</button>
    </div>
  );
}
