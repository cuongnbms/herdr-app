import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QUICK_REPLIES,
  loadQuickReplies,
  normalizeReplies,
  QUICK_REPLIES_MAX,
  QUICK_REPLY_MAX_CHARS,
  quickReplyButtons,
  useQuickReplies,
} from "./quickReplies";

const KEY = "herdr-app:settings";

beforeEach(() => {
  localStorage.clear();
  useQuickReplies.setState(loadQuickReplies());
});

describe("quick replies", () => {
  it("defaults to shown, with the canned list", () => {
    expect(loadQuickReplies()).toEqual({ show: true, replies: DEFAULT_QUICK_REPLIES });
    expect(DEFAULT_QUICK_REPLIES).toEqual(["continue", "yes", "no", "commit and push", "retry"]);
  });

  it("keeps strings only, capped in count and length; anything else falls back to the defaults", () => {
    expect(normalizeReplies(["ok", 3, null, "x".repeat(QUICK_REPLY_MAX_CHARS + 5)])).toEqual(["ok", "x".repeat(QUICK_REPLY_MAX_CHARS)]);
    expect(normalizeReplies(Array.from({ length: 20 }, (_, i) => `r${i}`))).toHaveLength(QUICK_REPLIES_MAX);
    expect(normalizeReplies("continue")).toEqual(DEFAULT_QUICK_REPLIES);
    expect(normalizeReplies([])).toEqual([]);
  });

  it("offers a button only for the replies with text", () => {
    expect(quickReplyButtons(["run the ", "", "  ", "ship it"])).toEqual(["run the ", "ship it"]);
  });

  it("saves into the shared settings object without dropping other keys", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "light" }));
    useQuickReplies.getState().setReplies(["go on", ""]);
    useQuickReplies.getState().setShow(false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ theme: "light", quickReplies: ["go on", ""], showQuickReplies: false });
    expect(loadQuickReplies()).toEqual({ show: false, replies: ["go on", ""] });
  });

  it("resets the list to the defaults", () => {
    useQuickReplies.getState().setReplies(["only"]);
    useQuickReplies.getState().reset();
    expect(useQuickReplies.getState().replies).toEqual(DEFAULT_QUICK_REPLIES);
    expect(loadQuickReplies().replies).toEqual(DEFAULT_QUICK_REPLIES);
  });
});
