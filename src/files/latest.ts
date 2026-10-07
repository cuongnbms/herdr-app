export const STALE: unique symbol = Symbol("stale");

/** Wrap an async function so a call that settles after a newer call started resolves to `STALE`. */
export function latestOnly<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
): (...a: A) => Promise<R | typeof STALE> {
  let latest = 0;
  return async (...a) => {
    const mine = ++latest;
    try {
      const value = await fn(...a);
      return mine === latest ? value : STALE;
    } catch (e) {
      if (mine !== latest) return STALE;
      throw e;
    }
  };
}
