import { useEffect, useState } from "react";
import { filesImage } from "../lib/ipc";

/** `mtime` changing (a poll found the image changed) fetches it again. */
export function ImageView({ machineId, root, rel, mtime }: { machineId: string; root: string; rel: string; mtime: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actual, setActual] = useState(false);

  useEffect(() => {
    let made: string | null = null;
    let gone = false;
    setUrl(null);
    setError(null);
    setActual(false);
    // `gone` drops the answer of a fetch this effect no longer wants.
    filesImage(machineId, root, rel).then(
      (buf) => {
        if (gone) return;
        const type = rel.toLowerCase().endsWith(".svg") ? "image/svg+xml" : undefined;
        made = URL.createObjectURL(new Blob([buf], type ? { type } : undefined));
        setUrl(made);
      },
      (e) => {
        if (!gone) setError(String((e as { message?: string })?.message ?? e));
      },
    );
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [machineId, root, rel, mtime]);

  if (error) return <div className="files-notice">{error}</div>;
  if (!url) return null;
  return (
    <div className="files-image-wrap">
      <img className={actual ? "files-image actual" : "files-image"} src={url} alt={rel} onClick={() => setActual((a) => !a)} />
    </div>
  );
}
