import { useEffect, useState } from "react";
import { filesImage } from "../lib/ipc";
import { imageUrl } from "./ImageView";

/** An image of rendered markdown read from the Machine (`rel` is root-relative); its alt text until then, or if it cannot be read. */
export function MarkdownImage({ machineId, root, rel, alt, title }: { machineId: string; root: string; rel: string; alt: string; title?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let gone = false;
    setUrl(null);
    filesImage(machineId, root, rel).then(
      (buf) => {
        if (gone) return;
        made = imageUrl(buf, rel);
        setUrl(made);
      },
      () => {},
    );
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [machineId, root, rel]);
  if (!url) return <span className="chat-image-link" title={title ?? rel}>{alt || rel}</span>;
  return <img className="files-markdown-image" src={url} alt={alt} title={title} />;
}
