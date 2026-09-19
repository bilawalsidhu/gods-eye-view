/**
 * DATA LAYERS panel — UI/UX and WCAG 2.2 AA regressions found in the
 * 2026-09-19 sweep (docs/audit/ui-ux-sweep-2026-09-19.md):
 *  - labels ("Live Flights", "Military Flights") wrapped onto two lines;
 *  - the last visible row sat half-clipped at the panel edge with no scroll
 *    affordance;
 *  - 9 px meta text and the OFF badge used --text-dim (2.5:1) and the control
 *    border read 1.2:1 against the glass ground (SC 1.4.3 / 1.4.11);
 *  - toggle, chip and collapse targets were below 24 × 24 px (SC 2.5.8);
 *  - feed-state changes had no live region (SC 4.1.3);
 *  - no global reduce-motion rule (SC 2.3.3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');
const radioCss = read('./ui/styles/radio.css');
const layersCss = read('./ui/styles/layers.css');
const controlsCss = read('./ui/styles/controls.css');
const foundationCss = read('./ui/styles/foundation.css');
const layerPanelSource = read('./ui/layerPanel.js');
const hudSource = read('./hud.js');

/** The CSS block for one selector (first match), declarations only. */
function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `rule ${selector} missing`);
  return css.slice(start, css.indexOf('}', start));
}

// ── Contrast (WCAG 2.x relative luminance) ───────────────────────────────────

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrastRatio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
/** Composite an rgba() colour over an opaque ground. */
export function over(rgba, ground) {
  const [r, g, b, a] = rgba;
  return ground.map((base, i) => Math.round(a * [r, g, b][i] + (1 - a) * base));
}
function rgbaToken(css, name) {
  const match = new RegExp(
    `${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([0-9.]+)\\)`,
  ).exec(css);
  assert.ok(match, `${name} token missing`);
  return match.slice(1).map(Number);
}

// The measured ground of the DATA LAYERS glass panel over the dark globe
// (rgba(22,22,22,0.78) over the #0a0b0b app background ≈ #121213).
const PANEL_GROUND = [18, 18, 19];

test('readable-dim text and the control border clear WCAG 2.2 AA on the panel ground', () => {
  const readable = rgbaToken(foundationCss, '--text-readable-dim');
  const border = rgbaToken(foundationCss, '--control-border-aa');
  const dim = rgbaToken(foundationCss, '--text-dim');
  const textRatio = contrastRatio(over(readable, PANEL_GROUND), PANEL_GROUND);
  const borderRatio = contrastRatio(over(border, PANEL_GROUND), PANEL_GROUND);
  const dimRatio = contrastRatio(over(dim, PANEL_GROUND), PANEL_GROUND);
  assert.ok(textRatio >= 4.5, `SC 1.4.3 normal text: ${textRatio.toFixed(2)}:1`);
  assert.ok(borderRatio >= 3, `SC 1.4.11 component boundary: ${borderRatio.toFixed(2)}:1`);
  // The old token is documented as decorative-only: it must NOT be the colour
  // of the 9 px reason strings, the OFF badge or the chips any more.
  assert.ok(dimRatio < 4.5, 'guard: --text-dim is still the low-contrast token');
  for (const selector of ['.data-toggle-meta', '.data-toggle-btn', '.data-toggle-chip']) {
    const rule = block(radioCss, selector);
    assert.match(rule, /color:\s*var\(--text-readable-dim\)/, `${selector} colour`);
    assert.doesNotMatch(rule, /color:\s*var\(--text-dim\)/, `${selector} still on --text-dim`);
  }
  assert.match(block(radioCss, '.data-toggle-btn'), /border:\s*1px solid var\(--control-border-aa\)/);
  assert.match(block(radioCss, '.data-toggle-chip'), /border:\s*1px solid var\(--control-border-aa\)/);
});

test('status colours keep AA contrast on their tinted badge grounds', () => {
  const cases = [
    ['ON', [59, 183, 149], over([59, 183, 149, 0.15], PANEL_GROUND)],
    ['DEGRADED', [255, 173, 114], over([255, 112, 48, 0.1], PANEL_GROUND)],
    ['UNAVAILABLE', [255, 133, 133], over([255, 60, 60, 0.1], PANEL_GROUND)],
    ['STALE', [255, 210, 122], over([255, 174, 51, 0.1], PANEL_GROUND)],
    ['icon live #3bb795', [59, 183, 149], PANEL_GROUND],
    ['icon off #999999', [153, 153, 153], PANEL_GROUND],
  ];
  for (const [name, fg, bg] of cases) {
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, `${name}: ${ratio.toFixed(2)}:1`);
  }
});

// ── Layout: single-line labels, no clipped rows ──────────────────────────────

test('row labels never wrap and the row keeps one line', () => {
  const name = block(radioCss, '.data-name');
  assert.match(name, /white-space:\s*nowrap/);
  assert.match(name, /text-overflow:\s*ellipsis/);
  assert.match(name, /overflow:\s*hidden/);
  assert.match(name, /min-width:\s*0/);
  const left = block(radioCss, '.data-toggle-left');
  assert.match(left, /min-width:\s*0/);
  assert.match(left, /flex:\s*1 1 auto/);
  assert.match(block(radioCss, '.data-toggle-right'), /flex:\s*none/);
  assert.match(block(radioCss, '.data-count'), /white-space:\s*nowrap/);
  // Wide status chips are narrower than before and take the count's room on
  // every row (not only ALPR), so the label keeps its line.
  assert.match(
    radioCss,
    /\.data-toggle-btn\.feed-unavailable \{\s*min-width:\s*74px/,
  );
  assert.match(
    layersCss,
    /\.data-toggle-row\s+\.data-toggle-right:has\(\s*\.data-toggle-btn:is\(/,
  );
  // The full label survives truncation as the element title.
  assert.match(layerPanelSource, /name\.title = panelLabel\(layer\)/);
});

test('the layer list scrolls and fades its edge while rows are hidden below', () => {
  const list = block(layersCss, '.data-toggle-list');
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /scrollbar-gutter:\s*stable/);
  assert.match(
    layersCss,
    /\.data-panel-inner:has\(\s*\.data-toggle-list\[data-overflow='true'\]:not\(\[data-at-end='true'\]\)\s*\)::after \{\s*opacity:\s*1/,
  );
  assert.match(layerPanelSource, /_syncOverflowAffordance\(\)/);
  assert.match(layerPanelSource, /list\.dataset\.overflow = String\(overflows\)/);
  assert.match(layerPanelSource, /this\._bind\(container, 'scroll', sync\)/);
});

// ── Target size (SC 2.5.8) ───────────────────────────────────────────────────

test('toggle, chip and collapse controls are at least 24 px tall and wide', () => {
  assert.match(block(radioCss, '.data-toggle-btn'), /min-height:\s*24px/);
  assert.match(block(radioCss, '.data-toggle-btn'), /min-width:\s*38px/);
  assert.match(block(radioCss, '.data-toggle-chip'), /min-height:\s*24px/);
  const collapse = block(controlsCss, '.panel-collapse-btn');
  assert.match(collapse, /width:\s*24px/);
  assert.match(collapse, /height:\s*24px/);
});

// ── Live region (SC 4.1.3) ───────────────────────────────────────────────────

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.parentNode = null;
    this.listeners = {};
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollTop = 0;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  removeEventListener(type) {
    delete this.listeners[type];
  }
  querySelector(selector) {
    const cls = selector.replace(/^\./, '');
    const walk = (node) => {
      for (const child of node.children) {
        if (child.className.split(/\s+/).includes(cls)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
}

test('LayerPanel mounts a polite status region and announces feed-state transitions', async () => {
  const { LayerPanel } = await import('./ui/layerPanel.js');
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Node(tag), hidden: false };
  try {
    const inner = new Node('div');
    const list = new Node('div');
    inner.appendChild(list);
    const panel = new LayerPanel({
      getLayers: () => [],
      isEnabled: () => false,
      setEnabled: async () => {},
      setLayerParams: () => {},
      getRowControls: () => null,
      hasRowControls: () => false,
      subscribeRowControls: () => null,
    });
    // Mount with an empty catalog: the region is created beside the list.
    panel.mount(list);
    const region = inner.querySelector('.data-layer-status');
    assert.ok(region, 'status region created next to the list');
    assert.equal(region.getAttribute('role'), 'status');
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.equal(region.getAttribute('aria-atomic'), 'true');
    assert.equal(list.dataset.overflow, 'false');
    assert.equal(list.dataset.atEnd, 'true');

    // A row whose toggle moves LOADING -> DEGRADED is announced once; the
    // first paint and an OFF row are silent.
    const row = new Node('div');
    const name = new Node('span');
    name.className = 'data-name';
    name.textContent = 'Live Flights';
    row.appendChild(name);
    const button = new Node('button');
    button.dataset.feedState = 'loading';
    button.textContent = 'LOADING';
    panel._syncRowFeedState(row, button);
    assert.equal(region.textContent, '', 'initial paint is not announced');
    button.dataset.feedState = 'degraded';
    button.textContent = 'DEGRADED';
    panel._syncRowFeedState(row, button);
    assert.equal(region.textContent, 'Live Flights: DEGRADED');
    button.dataset.feedState = 'off';
    button.textContent = 'OFF';
    panel._syncRowFeedState(row, button);
    assert.equal(region.textContent, 'Live Flights: DEGRADED', 'OFF is silent');
    // Overflow mirror: a list taller than its box flags overflow until scrolled to the end.
    list.scrollHeight = 1359;
    list.clientHeight = 251;
    list.scrollTop = 0;
    list.listeners.scroll();
    assert.equal(list.dataset.overflow, 'true');
    assert.equal(list.dataset.atEnd, 'false');
    list.scrollTop = 1359 - 251;
    list.listeners.scroll();
    assert.equal(list.dataset.atEnd, 'true');
    panel.destroy();
  } finally {
    globalThis.document = previous;
  }
});

// ── Reduced motion (SC 2.3.3) ────────────────────────────────────────────────

test('reduce-motion preference disables CSS motion globally and holds the HUD REC dot steady', () => {
  assert.match(
    foundationCss,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation-duration:\s*0\.01ms !important[\s\S]*transition-duration:\s*0\.01ms !important/,
  );
  assert.match(hudSource, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(hudSource, /reduceMotion \? true : !this\._recBlinkState/);
});
