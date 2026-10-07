import { useEffect, useState } from "react";
import { filesImage } from "../lib/ipc";
import { latestOnly, STALE } from "./latest";

export function ImageView({ machineId, root, rel }: { machineId: string; root: string; rel: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actual, setActual] = useState(false);

  useEffect(() => {
    let made: string | null = null;
    let gone = false;
    const fetchImage = latestOnly(() => filesImage(machineId, root, rel));
    setUrl(null);
    setError(null);
    setActual(false);
    fetchImage().then(
      (buf) => {
        if (gone || buf === STALE) return;
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
  }, [machineId, root, rel]);

  if (error) return <div className="files-notice">{error}</div>;
  if (!url) return null;
  return (
    <div className="files-image-wrap">
      <img className={actual ? "files-image actual" : "files-image"} src={url} alt={rel} onClick={() => setActual((a) => !a)} />
    </div>
  );
}
