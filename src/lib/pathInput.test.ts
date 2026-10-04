import { describe, expect, it } from "vitest";
import { dirSuggestions, splitDirPrefix } from "./pathInput";

describe("splitDirPrefix", () => {
  it("splits an absolute or home path at its last slash", () => {
    expect(splitDirPrefix("/home/u/pro")).toEqual({ dir: "/home/u", prefix: "pro" });
    expect(splitDirPrefix("/home/u/")).toEqual({ dir: "/home/u", prefix: "" });
    expect(splitDirPrefix("/ho")).toEqual({ dir: "/", prefix: "ho" });
    expect(splitDirPrefix("~/")).toEqual({ dir: "~", prefix: "" });
    expect(splitDirPrefix("~/src/a")).toEqual({ dir: "~/src", prefix: "a" });
  });

  it("does not list relative paths or a bare tilde", () => {
    expect(splitDirPrefix("")).toBeNull();
    expect(splitDirPrefix("src/a")).toBeNull();
    expect(splitDirPrefix("~")).toBeNull();
  });
});

describe("dirSuggestions", () => {
  const names = [".config", "Apps", "api", "web"];

  it("matches the prefix ignoring case and hides dotfolders", () => {
    expect(dirSuggestions(names, "/srv", "a")).toEqual(["/srv/Apps", "/srv/api"]);
    expect(dirSuggestions(names, "/srv", "")).toEqual(["/srv/Apps", "/srv/api", "/srv/web"]);
  });

  it("shows dotfolders once a dot is typed", () => {
    expect(dirSuggestions(names, "~", ".")).toEqual(["~/.config"]);
  });

  it("does not double the root slash", () => {
    expect(dirSuggestions(["usr"], "/", "")).toEqual(["/usr"]);
  });
});
