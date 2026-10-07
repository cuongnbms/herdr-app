import { describe, expect, it } from "vitest";
import { latestOnly, STALE } from "./latest";

describe("latestOnly", () => {
  it("drops a response that settles after a newer call started", async () => {
    let resolveFirst!: (v: string) => void;
    const calls = [new Promise<string>((r) => (resolveFirst = r)), Promise.resolve("second")];
    let i = 0;
    const f = latestOnly(() => calls[i++]);
    const first = f();
    const second = f();
    resolveFirst("first");
    expect(await first).toBe(STALE);
    expect(await second).toBe("second");
  });
});
