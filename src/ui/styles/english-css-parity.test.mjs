// Layout rules written for long translations must not change the English
// rendering: every rule checked here has no `html:not([lang='en'])` guard,
// so it applies to English too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = (name) => readFileSync(join(here, name), 'utf8');

/** Declarations of every rule whose (unguarded) selector list is `selector`. */
function unguardedRules(source, selector) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const want = norm(selector);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    // The captured "selector" may carry the tail of a preceding block
    // (comments, an @media prelude); keep what follows the last `}` or `*/`.
    const raw = m[1].split(/\*\/|\}/).pop();
    const sel = norm(raw);
    if (sel === want && !sel.includes("html:not([lang='en'])")) out.push(m[2]);
  }
  return out;
}

function declaration(block, prop) {
  const m = block.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
}

test('layer status chip keeps its English width (82px)', () => {
  const rules = unguardedRules(
    css('radio.css'),
    `.data-toggle-btn.feed-loading, .data-toggle-btn.feed-degraded,
     .data-toggle-btn.feed-stale, .data-toggle-btn.feed-partial,
     .data-toggle-btn.feed-fallback, .data-toggle-btn.feed-unavailable`,
  );
  assert.equal(rules.length, 1);
  assert.equal(declaration(rules[0], 'min-width'), '82px');
});

test('Directions steps keep one line with an ellipsis in English', () => {
  const [rule] = unguardedRules(css('radio.css'), '.data-row-list-text');
  assert.ok(rule);
  assert.equal(declaration(rule, 'white-space'), 'nowrap');
  assert.equal(declaration(rule, 'text-overflow'), 'ellipsis');
});

test('count-line layout is not reachable from an unguarded selector', () => {
  const source = css('radio.css');
  assert.equal(
    unguardedRules(source, '.data-toggle-row--count-line .data-count').length,
    0,
  );
});

test('weather status line keeps its fixed English height', () => {
  const [rule] = unguardedRules(
    css('weather.css'),
    ".weather-card [data-line-id='status']",
  );
  assert.ok(rule);
  assert.equal(declaration(rule, 'height'), '1.45em');
});

test('cockpit number separators keep the English cell width', () => {
  assert.equal(
    unguardedRules(css('cockpit.css'), '.cockpit-roll-token.is-separator')
      .length,
    0,
  );
});

test('Bhote Koshi callout keeps its English footer layout', () => {
  const source = css('bhote-koshi.css');
  const [strong] = unguardedRules(
    source,
    '.bhote-embedded-callout footer strong',
  );
  assert.equal(declaration(strong, 'white-space'), 'nowrap');
  const [link] = unguardedRules(source, '.bhote-embedded-callout footer a');
  assert.equal(declaration(link, 'grid-row'), '1 / span 2');
});

test('SCENES actions stay on one line in English', () => {
  assert.equal(
    unguardedRules(css('scenes.css'), '#scene-panel .scene-controls .scene-btn')
      .length,
    0,
  );
  const [select] = unguardedRules(css('scenes.css'), '#scene-select');
  assert.equal(declaration(select, 'white-space'), undefined);
});

test('Display and parameter rows keep their English layout', () => {
  const source = css('controls.css');
  assert.equal(
    unguardedRules(source, '.pp-slider-row > .pp-slider-mini-label').length,
    0,
  );
  assert.equal(unguardedRules(source, '#param-sliders').length, 0);
  const [row] = unguardedRules(source, '.param-slider-row');
  assert.equal(declaration(row, 'display'), 'flex');
  const [color] = unguardedRules(source, '.draw-color-select');
  assert.equal(declaration(color, 'flex'), '0 0 74px');
});

test('weather setting rows keep the 56px English label column', () => {
  const source = css('weather.css');
  assert.equal(unguardedRules(source, '.rail-card-settings').length, 0);
  const [row] = unguardedRules(source, '.rail-card-setting');
  assert.equal(
    declaration(row, 'grid-template-columns'),
    '56px minmax(0, 1fr)',
  );
});

test('cockpit brief controls keep their English sizes', () => {
  const source = css('cockpit.css');
  const [auto] = unguardedRules(source, '#cockpit-brief-auto');
  assert.equal(declaration(auto, 'width'), '50px');
  assert.equal(unguardedRules(source, '.cockpit-brief-actions > *').length, 0);
});

test('the count-line class is set only outside English', async () => {
  const { setLocale } = await import('../../i18n/index.js');
  const { LayerPanel } = await import('../layerPanel.js');
  const classes = () => {
    const toggled = new Map();
    const node = () => ({
      textContent: '',
      classList: { toggle: (name, on) => toggled.set(name, on) },
      appendChild() {},
    });
    LayerPanel.prototype._syncCount.call(LayerPanel.prototype, node(), node(), {
      countLabel: '693 nearby · 93 on screen',
    });
    return toggled.get('data-toggle-row--count-line');
  };
  globalThis.document ??= { createElement: () => ({}) };
  try {
    setLocale('en');
    assert.equal(classes(), false);
    setLocale('es');
    assert.equal(classes(), true);
  } finally {
    setLocale('en');
  }
});

test('Recent Imagery readout keeps its English layout', () => {
  const source = css('recent-imagery.css');
  const one = (selector) => {
    const rules = unguardedRules(source, selector);
    assert.equal(rules.length, 1, selector);
    return rules[0];
  };
  // The SHOW chip shares its row with the reserved B half.
  assert.equal(
    unguardedRules(
      source,
      ".recent-imagery-readout:not([data-mode='ab']) .ri-card-chips .ri-chip[data-slot='a']",
    ).length,
    0,
  );
  assert.equal(
    unguardedRules(
      source,
      ".recent-imagery-readout:not([data-mode='ab']) .ri-card-chips .ri-chip[data-slot='b']",
    ).length,
    0,
  );
  // Slot rows: their own fixed 44px tag column, no subgrid.
  const selection = one('.recent-imagery-readout .ri-selection');
  assert.equal(declaration(selection, 'grid-template-columns'), undefined);
  assert.equal(declaration(selection, 'column-gap'), undefined);
  assert.equal(
    declaration(one('.recent-imagery-readout .ri-mode'), 'grid-column'),
    undefined,
  );
  const slot = one('.recent-imagery-readout .ri-slot');
  assert.equal(
    declaration(slot, 'grid-template-columns'),
    '44px minmax(0, 1fr) 22px',
  );
  assert.equal(declaration(slot, 'grid-column'), undefined);
  assert.equal(declaration(slot, 'height'), '20px');
  assert.equal(
    declaration(one('.recent-imagery-readout .ri-slot-tag'), 'padding'),
    undefined,
  );
  // Opacity / SWAP / export row: fixed English columns.
  assert.equal(
    declaration(
      one('.recent-imagery-readout .ri-controls'),
      'grid-template-columns',
    ),
    '76px minmax(0, 1fr) 40px 128px',
  );
  const label = one('.recent-imagery-readout .ri-opacity-label');
  assert.equal(declaration(label, 'flex-wrap'), undefined);
  assert.equal(declaration(label, 'gap'), '4px');
  assert.equal(declaration(label, 'line-height'), undefined);
  const swap = one('.recent-imagery-readout .ri-swap');
  assert.equal(declaration(swap, 'width'), '40px');
  assert.equal(declaration(swap, 'min-width'), undefined);
});

test('CCTV control buttons stay on one line in English', () => {
  assert.equal(
    unguardedRules(css('cctv.css'), '.cctv-controls .scene-btn').length,
    0,
  );
});
