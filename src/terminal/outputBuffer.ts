/** How often a hidden terminal parses its buffered output. */
export const HIDDEN_FLUSH_MS = 50;
/** A hidden drain writes whole chunks until a slice reaches this size... */
export const SLICE_BYTES = 16 * 1024;
/** ...and at most this many slices, so a busy hidden terminal can't starve the visible one. */
const SLICES_PER_FLUSH = 2;

type Write = (data: Uint8Array, onParsed: () => void) => void;

interface Chunk {
  data: Uint8Array;
  onParsed: () => void;
}

function concat(chunks: Chunk[]): Uint8Array {
  if (chunks.length === 1) return chunks[0].data;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.data.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c.data, at);
    at += c.data.byteLength;
  }
  return out;
}

/**
 * Terminal output: written straight through while the terminal is visible; while hidden,
 * held and parsed in small slices every HIDDEN_FLUSH_MS. Chunks are only ever joined, never
 * split, and each chunk's `onParsed` fires once its slice is parsed, so flow-control acks
 * stay exact. Throttled hidden output backs up into the backend's flow control.
 */
export function createOutputBuffer(write: Write) {
  let visible = false;
  let disposed = false;
  let pending: Chunk[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const writeChunks = (chunks: Chunk[]) => write(concat(chunks), () => chunks.forEach((c) => c.onParsed()));

  const drain = () => {
    timer = undefined;
    for (let s = 0; s < SLICES_PER_FLUSH && pending.length; s++) {
      let n = 0;
      let take = 0;
      while (take < pending.length && n < SLICE_BYTES) n += pending[take++].data.byteLength;
      writeChunks(pending.splice(0, take));
    }
    if (pending.length) timer = setTimeout(drain, HIDDEN_FLUSH_MS);
  };

  return {
    write(data: Uint8Array, onParsed: () => void) {
      if (disposed) return;
      if (visible) return write(data, onParsed);
      pending.push({ data, onParsed });
      timer ??= setTimeout(drain, HIDDEN_FLUSH_MS);
    },
    setVisible(v: boolean) {
      if (disposed || v === visible) return;
      visible = v;
      if (!v) return;
      clearTimeout(timer);
      timer = undefined;
      // xterm time-slices its own parsing, so one write doesn't block the reveal.
      if (pending.length) writeChunks(pending.splice(0));
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
  };
}
