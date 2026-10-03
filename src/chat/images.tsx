import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useState } from "react";
import { chatImage } from "../lib/ipc";
import { paneKey, type ImageRef, type PaneRef } from "../lib/types";

/** The Pane whose Transcript is on screen; images fetch their bytes through it. */
export const ChatPaneContext = createContext<PaneRef | null>(null);

type Entry = { promise: Promise<string>; url: string | null };
const cache = new Map<string, Entry>();

function load(pane: PaneRef, image: ImageRef): Entry {
  const k = `${paneKey(pane)}\n${image.ref}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const entry: Entry = {
    url: null,
    promise: chatImage(pane, image.ref).then((bytes) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: image.media_type }));
      // Not revoked yet: revokeChatImages drops an entry from the cache before its bytes arrive.
      if (cache.get(k) === entry) entry.url = url;
      else URL.revokeObjectURL(url);
      return url;
    }),
  };
  cache.set(k, entry);
  // A failure is not remembered: a later mount asks again.
  entry.promise.catch(() => {
    if (cache.get(k) === entry) cache.delete(k);
  });
  return entry;
}

/** Revokes the object URLs of one Pane's images and forgets them. A fetch still in flight is
 * dropped from the cache and its URL is revoked when it arrives. */
export function revokeChatImages(key: string): void {
  for (const [k, entry] of [...cache]) {
    if (!k.startsWith(`${key}\n`)) continue;
    cache.delete(k);
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

export function useChatImage(pane: PaneRef, image: ImageRef): { url: string | null; failed: boolean } {
  // Keyed by value, not by the pane object: callers may pass a fresh equal object on every render.
  const k = `${paneKey(pane)}\n${image.ref}`;
  const peek = cache.get(k)?.url ?? null;
  const [state, setState] = useState<{ k: string; url: string | null; failed: boolean }>({ k, url: peek, failed: false });
  useEffect(() => {
    let live = true;
    load(pane, image).promise.then(
      (url) => live && setState({ k, url, failed: false }),
      () => live && setState({ k, url: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [k, image.media_type]); // eslint-disable-line react-hooks/exhaustive-deps
  // A state left over from another image is ignored; an already-resolved entry shows at once.
  return state.k === k ? state : { url: peek, failed: false };
}

function ImageViewer({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // In the body: a virtual row's transform would confine a fixed overlay to the row.
  return createPortal(
    <div className="image-viewer" role="dialog" aria-label="Image" onClick={onClose}>
      <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}

function ChatImageView({ pane, image, n }: { pane: PaneRef; image: ImageRef; n: number }) {
  const { url, failed } = useChatImage(pane, image);
  const [open, setOpen] = useState(false);
  if (failed) return <div className="chat-image-missing">Image unavailable</div>;
  // A fixed-size box while pending keeps the row's height stable.
  if (!url) return <div className="chat-image chat-image-pending" aria-hidden="true" />;
  return (
    <>
      <button className="chat-image" aria-label={`Open image ${n}`} onClick={() => setOpen(true)}>
        <img src={url} alt={`Image ${n}`} />
      </button>
      {open && <ImageViewer url={url} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ChatImages({ images }: { images: ImageRef[] }) {
  const pane = useContext(ChatPaneContext);
  if (!pane) return null;
  return (
    <div className="chat-images">
      {images.map((image, i) => (
        <ChatImageView key={image.ref} pane={pane} image={image} n={i + 1} />
      ))}
    </div>
  );
}
