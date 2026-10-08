import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { applyHoldSelection } from "./holdSelection";

// jsdom has no matchMedia; xterm's renderer watches the device pixel ratio through it.
window.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {} }) as unknown as MediaQueryList;

async function termWith(text: string) {
  const term = new Terminal({ cols: 40, rows: 5 });
  const host = document.createElement("div");
  document.body.appendChild(host);
  term.open(host);
  await new Promise<void>((r) => term.write(text, r));
  return term;
}

/** A listener on the terminal element, where xterm reports mouse moves from. */
function moves(term: Terminal) {
  const seen = vi.fn();
  term.element!.addEventListener("mousemove", seen);
  const move = (buttons = 0) => term.element!.querySelector(".xterm-screen")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons }));
  return { seen, move };
}

describe("applyHoldSelection", () => {
  it("keeps a plain move from xterm while there is a selection", async () => {
    const term = await termWith("hello");
    applyHoldSelection(term);
    const { seen, move } = moves(term);
    term.select(0, 0, 5);
    move();
    expect(seen).not.toHaveBeenCalled();
    expect(term.getSelection()).toBe("hello");
    term.dispose();
  });

  it("lets moves through without a selection or with a button held", async () => {
    const term = await termWith("hello");
    applyHoldSelection(term);
    const { seen, move } = moves(term);
    move();
    term.select(0, 0, 5);
    move(1);
    expect(seen).toHaveBeenCalledTimes(2);
    term.dispose();
  });

  it("lets moves through once disposed", async () => {
    const term = await termWith("hello");
    const dispose = applyHoldSelection(term);
    const { seen, move } = moves(term);
    term.select(0, 0, 5);
    dispose();
    move();
    expect(seen).toHaveBeenCalledOnce();
    term.dispose();
  });
});
