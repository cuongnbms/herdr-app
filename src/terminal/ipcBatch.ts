/** Acks are summed and sent once per tick, or at once past this many bytes. Must stay
 * well below the backend's LOW_WATER so the reader can never wait on a pending flush. */
const ACK_THRESHOLD = 64 * 1024;

/**
 * Terminal input: each push is written at once; input arriving while a write is in
 * flight is merged into the next write, so order holds and key-repeat bursts still batch.
 */
export function createInputQueue(send: (data: string) => Promise<unknown>) {
  let inflight = false;
  let pending = "";
  let disposed = false;
  const flush = (data: string) => {
    inflight = true;
    void send(data)
      .catch(() => {})
      .finally(() => {
        inflight = false;
        if (disposed || !pending) return;
        const next = pending;
        pending = "";
        flush(next);
      });
  };
  return {
    push(data: string) {
      if (disposed) return;
      if (inflight) pending += data;
      else flush(data);
    },
    dispose() {
      disposed = true;
      pending = "";
    },
  };
}

/** Sums output acks. Not tied to rAF: a hidden window must keep acking or the reader stalls. */
export function createAckBatcher(ack: (bytes: number) => Promise<unknown>, threshold = ACK_THRESHOLD) {
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const n = total;
    total = 0;
    if (n) void ack(n).catch(() => {});
  };
  return {
    add(bytes: number) {
      total += bytes;
      if (total >= threshold) flush();
      else if (timer === undefined) timer = setTimeout(flush, 0);
    },
  };
}
