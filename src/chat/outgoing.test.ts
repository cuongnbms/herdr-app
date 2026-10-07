import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/types";
import { consume, echoes, type Outgoing } from "./outgoing";

const out = (id: number, text: string, sent = true): Outgoing => ({ id, text, previews: [], sent });
const user = (text: string): ChatItem => ({ kind: "user", text });

describe("echoes", () => {
  it("is true for a message the transcript will show as the user's", () => {
    expect(echoes("fix the bug", 0)).toBe(true);
    expect(echoes("", 1)).toBe(true);
  });

  it("is false for slash and shell commands, which the transcript shows otherwise or not at all", () => {
    expect(echoes("/model sonnet", 0)).toBe(false);
    expect(echoes("  /clear", 0)).toBe(false);
    expect(echoes("!ls", 0)).toBe(false);
    expect(echoes("   ", 0)).toBe(false);
  });
});

describe("consume", () => {
  it("drops the outgoing message a user item echoes, matching whitespace loosely", () => {
    const r = consume([out(1, "first"), out(2, "second\n  line")], [user("second line")]);
    expect(r.list.map((o) => o.id)).toEqual([1]);
    expect(r.gone.map((o) => o.id)).toEqual([2]);
  });

  it("matches text the agent prefixed, as with image mentions", () => {
    const r = consume([out(1, "look at this")], [user("[Image #1] look at this")]);
    expect(r.list).toEqual([]);
  });

  it("matches an image-only send with the first user item", () => {
    const r = consume([out(1, "")], [{ kind: "user", text: "", images: [{ ref: "r", media_type: "image/png" }] }]);
    expect(r.list).toEqual([]);
  });

  it("keeps messages no user item echoes, and each item drops one message only", () => {
    const r = consume([out(1, "same"), out(2, "same")], [user("same"), { kind: "assistant_text", markdown: "same" }, user("other")]);
    expect(r.list.map((o) => o.id)).toEqual([2]);
  });

  it("does not match an image-only send with a text-only item", () => {
    const r = consume([out(1, "")], [user("hello")]);
    expect(r.list.map((o) => o.id)).toEqual([1]);
  });

  it("returns the same list when nothing matched", () => {
    const list = [out(1, "a")];
    expect(consume(list, [user("b")]).list).toBe(list);
  });
});
