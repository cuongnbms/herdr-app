import { describe, expect, it } from "vitest";
import { dropZone } from "./dnd";

const rect = { top: 100, height: 40 };
describe("dropZone", () => {
  it("splits a session row in halves", () => {
    expect(dropZone(rect, 100, "session")).toBe("before");
    expect(dropZone(rect, 119, "session")).toBe("before");
    expect(dropZone(rect, 120, "session")).toBe("after");
    expect(dropZone(rect, 139, "session")).toBe("after");
  });
  it("splits a group row in quarters with into in the middle", () => {
    expect(dropZone(rect, 109, "group")).toBe("before");
    expect(dropZone(rect, 110, "group")).toBe("into");
    expect(dropZone(rect, 129, "group")).toBe("into");
    expect(dropZone(rect, 130, "group")).toBe("after");
  });
  it("falls back when the row has no height", () => {
    expect(dropZone({ top: 0, height: 0 }, 0, "session")).toBe("after");
    expect(dropZone({ top: 0, height: 0 }, 0, "group")).toBe("into");
  });
});
