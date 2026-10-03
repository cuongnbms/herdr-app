/**
 * Which terminals may hold a WebGL context. WebKit keeps ~16 live per page and silently
 * drops the oldest past that, so only the visible terminal and a few recently shown ones
 * keep theirs; the rest go back to the DOM renderer until they are shown again.
 */
export const WEBGL_CONTEXTS = 6;

/** A terminal that lost its context this many times within the window stays on DOM. */
export const LOSS_LIMIT = 3;
export const LOSS_WINDOW_MS = 60_000;

/** Most recently shown first. */
export class WebglLru {
  private order: string[] = [];

  constructor(private readonly capacity: number) {}

  /** Marks `key` as shown; returns the keys pushed out, which must give up their context. */
  touch(key: string): string[] {
    this.order = [key, ...this.order.filter((k) => k !== key)];
    return this.order.splice(this.capacity);
  }

  remove(key: string): void {
    this.order = this.order.filter((k) => k !== key);
  }

  keys(): string[] {
    return [...this.order];
  }
}

const recent = (losses: number[], now: number) => losses.filter((t) => now - t < LOSS_WINDOW_MS);

export function recordLoss(losses: number[], now: number): number[] {
  return [...recent(losses, now), now];
}

export function mayUseWebgl(losses: number[], now: number): boolean {
  return recent(losses, now).length < LOSS_LIMIT;
}
