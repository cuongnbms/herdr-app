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

describe("latestOnly rejections", () => {
  it("turns a stale rejection into STALE and rethrows the latest one", async () => {
    let rejectFirst!: (e: unknown) => void;
    const calls = [new Promise<string>((_, r) => (rejectFirst = r)), Promise.reject(new Error("latest"))];
    let i = 0;
    const f = latestOnly(() => calls[i++]);
    const first = f();
    const second = f();
    rejectFirst(new Error("old"));
    expect(await first).toBe(STALE);
    await expect(second).rejects.toThrow("latest");
  });
});
