import { describe, expect, it } from "vitest";
import { activeTrigger, applyCompletion } from "./mentions";

describe("activeTrigger", () => {
  it("opens slash at the start of any line, plugin names included", () => {
    expect(activeTrigger("/co", 3)).toEqual({ kind: "slash", query: "co", start: 0, end: 3 });
    expect(activeTrigger("hi\n/sp:br", 9)).toEqual({ kind: "slash", query: "sp:br", start: 3, end: 9 });
  });
  it("ignores a slash mid-line or once the command has an argument", () => {
    expect(activeTrigger("see /co", 7)).toBeNull();
    expect(activeTrigger("/compact now", 12)).toBeNull();
  });
  it("opens nothing with the caret before the trigger character", () => {
    expect(activeTrigger("/compact now", 0)).toBeNull();
    expect(activeTrigger("\n/foo", 0)).toBeNull();
    expect(activeTrigger("hi\n/foo", 3)).toBeNull();
    expect(activeTrigger("$foo", 0, { skills: true })).toBeNull();
    expect(activeTrigger("@src", 0)).toBeNull();
  });
  it("opens file completion after an @ that starts a word", () => {
    expect(activeTrigger("look at @src/a", 14)).toEqual({ kind: "file", query: "src/a", start: 8, end: 14 });
    expect(activeTrigger("@", 1)).toBeNull();
    expect(activeTrigger("mail me@host", 12)).toBeNull();
  });
  it("covers the token past the caret", () => {
    expect(activeTrigger("@srX more", 3)).toEqual({ kind: "file", query: "sr", start: 0, end: 4 });
  });
  it("opens $ skills only when asked", () => {
    expect(activeTrigger("use $do", 7)).toBeNull();
    expect(activeTrigger("use $do", 7, { skills: true })).toEqual({ kind: "slash", prefix: "$", query: "do", start: 4, end: 7 });
  });
});

describe("applyCompletion", () => {
  it("replaces exactly the token and puts the caret after it", () => {
    expect(applyCompletion("/co more", { kind: "slash", query: "co", start: 0, end: 3 }, "/compact ")).toEqual({
      text: "/compact  more",
      caret: 9,
    });
  });
});
