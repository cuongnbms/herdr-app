import type { FileContent } from "../lib/types";
import { ImageView } from "./ImageView";
import { MarkdownView } from "./MarkdownView";
import { TextView } from "./TextView";

export type FileMode = "render" | "source";

const isMarkdown = (rel: string) => /\.(md|markdown)$/i.test(rel);

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileView({
  machineId,
  root,
  rel,
  content,
  mode,
  onOpen,
  find,
  initialScroll,
  onScroll,
}: {
  machineId: string;
  root: string;
  rel: string;
  content: FileContent;
  mode: FileMode;
  onMode(mode: FileMode): void;
  onOpen(rel: string): void;
  find: { query: string; index: number } | null;
  initialScroll: number;
  onScroll(top: number): void;
}) {
  if (content.kind === "image") return <ImageView machineId={machineId} root={root} rel={rel} />;
  if (content.kind === "binary" || content.text === null) {
    return (
      <div className="files-notice">
        <div>Binary file, not shown</div>
        <div className="files-notice-size">{formatSize(content.size)}</div>
      </div>
    );
  }
  return (
    <>
      {content.truncated && <div className="files-banner">Showing the first 2 MB</div>}
      {isMarkdown(rel) && mode === "render" ? (
        <MarkdownView text={content.text} rel={rel} onOpen={onOpen} />
      ) : (
        <TextView text={content.text} path={rel} initialScroll={initialScroll} onScroll={onScroll} find={find} />
      )}
    </>
  );
}
