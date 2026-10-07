import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatItem } from "../lib/types";

/**
 * A message the Composer sent that the transcript has not shown yet: the Chat lens shows it at
 * once, dimmed until the send went through, so a slow round trip (an ssh Machine) does not
 * leave the chat looking as if nothing happened. The transcript's own user item replaces it.
 */
export interface Outgoing {
  id: number;
  text: string;
  /** Object URLs of the pasted images, owned by the Outgoing once the send went through. */
  previews: string[];
  /** The send went through; false while it is on its way. */
  sent: boolean;
}

/** Whether a send shows up as a user item: slash commands and `!` shell commands do not. */
export function echoes(text: string, images: number): boolean {
  const t = text.trimStart();
  if (images > 0) return true;
  return t !== "" && !t.startsWith("/") && !t.startsWith("!");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Drops the oldest Outgoing each user item echoes; `gone` are the ones dropped. Claude and pi
 * keep the prompt's text as sent (Claude may put an image placeholder before it), so an item
 * that echoes none, such as Claude's note of an interrupt, drops nothing.
 */
export function consume(list: Outgoing[], items: ChatItem[]): { list: Outgoing[]; gone: Outgoing[] } {
  let rest = list;
  const gone: Outgoing[] = [];
  for (const item of items) {
    if (item.kind !== "user") continue;
    const text = norm(item.text);
    const images = !!item.images?.length;
    // An image-only send is echoed by an item with images.
    const hit = rest.find((o) => (o.text.trim() === "" ? images : text.includes(norm(o.text))));
    if (!hit) continue;
    gone.push(hit);
    rest = rest.filter((o) => o !== hit);
  }
  return { list: rest, gone };
}

const revoke = (urls: string[]) => urls.forEach((u) => u && URL.revokeObjectURL(u));
/** A sent Outgoing owns its previews; one still on its way leaves them to its settle. */
const release = (gone: Outgoing[]) => gone.forEach((o) => o.sent && revoke(o.previews));

let nextId = 0;

/**
 * The Chat lens's Outgoing messages. `start` adds one as the Composer sends (when the
 * transcript will echo it) and returns its settle; `seen` drops those the transcript's user items
 * echo; `clear` drops all, as when the chat moves to another pane or transcript.
 */
export function useOutgoing() {
  const [list, setList] = useState<Outgoing[]>([]);
  const ref = useRef(list);
  const set = useCallback((next: Outgoing[]) => {
    ref.current = next;
    setList(next);
  }, []);

  const start = useCallback(
    (text: string, previews: string[]) => {
      if (!echoes(text, previews.length)) return (ok: boolean) => ok && revoke(previews);
      const id = nextId++;
      set([...ref.current, { id, text, previews, sent: false }]);
      return (ok: boolean) => {
        const cur = ref.current.find((o) => o.id === id);
        // Dropped meanwhile (echoed, or cleared): the previews have no one else to revoke them.
        if (!cur) return ok && revoke(previews);
        set(ok ? ref.current.map((o) => (o === cur ? { ...o, sent: true } : o)) : ref.current.filter((o) => o !== cur));
      };
    },
    [set],
  );

  const seen = useCallback(
    (items: ChatItem[]) => {
      if (ref.current.length === 0) return;
      const r = consume(ref.current, items);
      if (r.gone.length === 0) return;
      release(r.gone);
      set(r.list);
    },
    [set],
  );

  const clear = useCallback(() => {
    if (ref.current.length === 0) return;
    release(ref.current);
    set([]);
  }, [set]);

  useEffect(() => () => release(ref.current), []);

  return { list, start, seen, clear };
}
