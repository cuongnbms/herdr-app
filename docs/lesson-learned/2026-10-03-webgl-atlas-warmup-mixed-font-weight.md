# WebGL terminal text mixed two font weights: ASCII heavier than Vietnamese

**Symptom**: In a terminal pane using the xterm.js WebGL renderer inside the Tauri
WKWebView, default-colored ASCII glyphs rendered noticeably heavier (Medium-like)
than Vietnamese glyphs, colored text, and the rest of the UI on the same line, with
the same installed font ("Lilex Nerd Font Mono"). It came and went, and switching to
another pane and back usually cleared it. A 500 ms "clear the atlas after attach"
workaround (commit 5c633f3) reduced it but did not remove it. The affected pane also
showed three `<canvas>` elements instead of the usual two.

**Root Cause**: The texture atlas in `@xterm/addon-webgl` rasterizes glyphs on a
temporary 2D canvas. For on-demand glyphs, `_drawToCache` first appends that canvas
(hidden) into the terminal element so it inherits the terminal's styles. The ASCII
warm-up (`warmUp` → `_doWarmUp`, characters 33–126) calls `_drawToCache` with
`domContainer = undefined`, so it draws while the canvas is still detached from the
document. WebKit resolves no computed style for a disconnected element, so canvas text
falls back to the default font description, which uses `-webkit-font-smoothing: auto`.
Once the canvas is in the document it inherits the app's `-webkit-font-smoothing:
antialiased` from `:root` in `src/styles.css`, which renders about 25–30 % less ink.
WKWebView has no `requestIdleCallback`, so the warm-up runs through `setTimeout(0)` and
usually finishes before the first render frame attaches the canvas. Result: ASCII with
default colors (served by the warm-up cache) is heavy, everything rasterized later is
light. Any new atlas (pane attach, theme switch, font size change, display change)
re-runs the warm-up, which is why the 500 ms clear only masked the attach case.

The third canvas was this hidden temporary canvas, not an overlay drawing twice.

**Fix**: A pnpm patch, `patches/@xterm__addon-webgl@0.19.0.patch` (registered in
`pnpm-workspace.yaml`), passes the terminal element into the warm-up so it draws under
the same styles as on-demand glyphs, and defers the warm-up while that element is not
connected. The `.js` and `.mjs` bundles carry the same change as the `src/` text below.
The 500 ms workaround in `src/terminal/webgl.ts` and its tests were removed.

```ts
// @xterm/addon-webgl src/TextureAtlas.ts
public warmUp(domContainer?: HTMLElement): void {
  if (this._didWarmUp) {
    return;
  }
  if (domContainer && !domContainer.isConnected) {
    return;
  }
  this._doWarmUp(domContainer);
  this._didWarmUp = true;
}

// _doWarmUp now forwards domContainer:
const rasterizedGlyph = this._drawToCache(i, DEFAULT_COLOR, DEFAULT_COLOR, DEFAULT_EXT, false, domContainer);

// WebglRenderer._refreshCharAtlas and BaseRenderLayer._refreshCharAtlas:
this._charAtlas.warmUp(this._terminal.element); // resp. terminal.element
```

**Evidence**: Measured in a real `WKWebView` (Playwright's WebKit did not reproduce
it), see `tmp/font-probe/README.md` for the Swift runner and the two probe pages.

| Measurement | Before patch | After patch |
|---|---|---|
| Same font and string, ink on a detached canvas / canvas inside the document | 3750 / 2708 | — |
| Real xterm + addon: ink of default-colored ASCII ÷ same ASCII in red | 1.237 | 1.005 |

`alpha: true/false`, NFC/NFD text and font load state made no difference; glyph widths
were identical in every case, so the font itself was never the variable.

**Notes**:
- `pnpm install` fails loudly if the patch no longer applies after an addon upgrade;
  re-create it with `pnpm patch @xterm/addon-webgl@<version>` and the same four edits.
- Vite caches optimized deps in `node_modules/.vite/deps`; restart `pnpm tauri dev`
  after changing the patch or the running app keeps the old addon.
- Not covered by the patch: a hidden terminal (its element detached from the DOM)
  rasterizing a new glyph on demand into the shared atlas. xterm pauses rendering while
  not intersecting and the app batches output while hidden, so this is rare, and the
  reveal path clears the atlas anyway. If mixed weights ever return, look there first.
- The upstream addon has the same gap for `font-feature-settings` inheritance; no
  upstream issue was filed.

**Applies to**: Any canvas text rasterized off-document in WebKit (glyph atlases,
measurement canvases, offscreen previews) when the page sets `-webkit-font-smoothing`
or `font-feature-settings`: a detached canvas, or one inside a disconnected subtree,
inherits nothing, so glyphs drawn before and after attaching differ. Keep the canvas
connected (hidden is fine) before drawing anything that will be cached.
