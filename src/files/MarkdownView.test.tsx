import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => new ArrayBuffer(0)), Channel: class {} }));
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn(async () => ({})), render: vi.fn(async () => ({ svg: "<svg></svg>" })) },
}));
import { invoke } from "@tauri-apps/api/core";
import { MarkdownView } from "./MarkdownView";

/** jsdom has no CSS Custom Highlight API; this stands in for it. */
class FakeHighlight extends Set<Range> {}
const highlights = new Map<string, FakeHighlight>();
const texts = (name: string) => [...(highlights.get(name) ?? [])].map((r) => r.toString());

beforeEach(() => {
  highlights.clear();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { escape: (s: string) => s, highlights });
});
afterEach(() => vi.unstubAllGlobals());

const base = { machineId: "local", root: "/r", rel: "a.md", onOpen: () => {}, initialScroll: 0, saveScroll: () => {} };

describe("MarkdownView find", () => {
  it("highlights matches in the rendered text and steps through them", () => {
    const status = vi.fn();
    const text = "# Foo title\n\nsome foo here\n\n`foo()`";
    const { rerender } = render(<MarkdownView {...base} text={text} find={{ query: "foo", index: 0, matchCase: false }} onFindStatus={status} />);
    expect(texts("files-find")).toEqual(["Foo", "foo", "foo"]);
    expect(texts("files-find-current")).toEqual(["Foo"]);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 0 });
    rerender(<MarkdownView {...base} text={text} find={{ query: "foo", index: 4, matchCase: false }} onFindStatus={status} />);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 1 });
    expect(texts("files-find-current")).toEqual(["foo"]);
    rerender(<MarkdownView {...base} text={text} find={{ query: "foo", index: 0, matchCase: true }} onFindStatus={status} />);
    expect(status).toHaveBeenLastCalledWith({ count: 2, index: 0 });
  });

  it("clears the highlights when find closes", () => {
    const { rerender } = render(<MarkdownView {...base} text="foo" find={{ query: "foo", index: 0, matchCase: false }} />);
    expect(texts("files-find")).toEqual(["foo"]);
    rerender(<MarkdownView {...base} text="foo" find={null} />);
    expect(highlights.size).toBe(0);
  });

  it("searches again when a <details> opens or closes", async () => {
    const status = vi.fn();
    const { container } = render(
      <MarkdownView {...base} text={"<details><summary>More foo</summary>\n\nhidden foo\n\n</details>\n\nfoo"} find={{ query: "foo", index: 0, matchCase: false }} onFindStatus={status} />,
    );
    expect(status).toHaveBeenLastCalledWith({ count: 2, index: 0 });
    container.querySelector("details")!.setAttribute("open", "");
    await waitFor(() => expect(status).toHaveBeenLastCalledWith({ count: 3, index: 0 }));
  });

  it("searches again when the rendered content changes", async () => {
    const status = vi.fn();
    const find = { query: "foo", index: 0, matchCase: false };
    const { rerender } = render(<MarkdownView {...base} text="foo" find={find} onFindStatus={status} />);
    expect(status).toHaveBeenLastCalledWith({ count: 1, index: 0 });
    rerender(<MarkdownView {...base} text={"foo\n\nfoo foo"} find={find} onFindStatus={status} />);
    await waitFor(() => expect(status).toHaveBeenLastCalledWith({ count: 3, index: 0 }));
    expect(texts("files-find")).toHaveLength(3);
  });
});

describe("MarkdownView raw HTML", () => {
  it("renders the safe tags", () => {
    const text = "<details open><summary>More</summary>\n\nPress <kbd>Cmd</kbd>, H<sub>2</sub>O, x<sup>2</sup><br>next\n\n</details>";
    const { container } = render(<MarkdownView {...base} text={text} />);
    const details = container.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(true);
    expect(details.querySelector("summary")!.textContent).toBe("More");
    expect(["kbd", "sub", "sup", "br"].map((t) => container.querySelectorAll(t).length)).toEqual([1, 1, 1, 1]);
  });

  it("drops scripts, frames, styles, handlers, remote images and javascript: links", () => {
    const text = [
      '<script>window.__pwned = 1</script>',
      '<iframe src="https://evil.test/f"></iframe><object data="https://evil.test/o"></object><embed src="https://evil.test/e">',
      '<style>body { display: none }</style>',
      '<p onclick="x()" style="color: red" onmouseover="y()">styled</p>',
      '<a href="javascript:alert(1)">js</a>',
      '<img src="https://evil.test/i.png" alt="remote"><img src="x.png" onerror="z()" srcset="https://evil.test/s.png 2x">',
      '<picture><source srcset="https://evil.test/p.png"><img src="https://evil.test/q.png" alt="pic"></picture>',
      '<video src="https://evil.test/v.mp4" poster="https://evil.test/p.png"></video><audio src="https://evil.test/a.mp3"></audio>',
      '<form action="https://evil.test"><input name="q"></form><link rel="stylesheet" href="https://evil.test/c.css"><meta http-equiv="refresh" content="0;url=https://evil.test">',
    ].join("\n\n");
    const { container } = render(<MarkdownView {...base} text={text} />);
    for (const tag of ["script", "iframe", "object", "embed", "style", "picture", "source", "video", "audio", "form", "link", "meta"]) {
      expect(container.querySelector(tag), tag).toBeNull();
    }
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).not.toContainEqual(expect.stringMatching(/evil/));
    expect(container.querySelector("[srcset]")).toBeNull();
    const attrs = [...container.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.name));
    expect(attrs.filter((a) => a.startsWith("on") || a === "style")).toEqual([]);
    expect(container.innerHTML).not.toMatch(/javascript:/);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByText("styled").tagName).toBe("P");
    expect(container.textContent).not.toMatch(/display: none|__pwned/);
  });

  it("loads a relative raw <img> from the Machine like a markdown image", async () => {
    vi.mocked(invoke).mockClear();
    render(<MarkdownView {...base} rel="docs/a.md" text={'<img src="pic.png" alt="Pic">'} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_image", { machineId: "local", root: "/r", rel: "docs/pic.png" }));
  });

  it("keeps heading ids and footnote links working", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = render(<MarkdownView {...base} text={"# Title\n\nSee[^1] and [top](#title).\n\n[^1]: The note."} />);
    expect(container.querySelector("h1")!.id).toBe("title");
    const ref = container.querySelector("sup a") as HTMLAnchorElement;
    fireEvent.click(ref);
    const target = vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0] as HTMLElement;
    expect(target.tagName).toBe("LI");
    expect(target.textContent).toContain("The note.");
  });
});
