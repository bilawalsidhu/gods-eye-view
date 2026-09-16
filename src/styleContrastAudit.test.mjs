// src/styleContrastAudit.test.mjs
//
// WCAG 2.1 AAA audit of every LITERAL text color in style.css (Batch F,
// 2026-09-15). src/uiContrast.test.mjs pins the design TOKENS; this file
// pins the ~190 one-off literal `color:` declarations that historically
// bypassed them — the audit that found cockpit captions at 2.9:1 and error
// text at 4.8:1 in the same worst case the tokens already guarded.
//
// Worst case per rule (same unit as uiContrast):
//
//   imagery(white) ← --glass-bg scrim ← [rule's own background veil] ← text
//
// and the symmetric glass-over-#0a0a0f case; the reported ratio is the
// MINIMUM of the two. A rule's own background (chip/button veils) layers
// between the scrim and the text with its real alpha. 7:1 = AAA text
// (WCAG 1.4.6); 3:1 = the 1.4.11 non-text bar for the documented glyphs.
//
// Rules are EXEMPT only via the explicit lists below, each with its reason.
// The test fails if an exempt selector stops matching the stylesheet, so
// the list cannot rot into dead weight.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readSource } from './testSupport/readSource.js';
import { contrastRatio, composite } from './testSupport/contrastMath.js';

const css = readSource('../style.css', import.meta.url);

const AAA_TEXT = 7;
const NON_TEXT = 3; // WCAG 1.4.11 graphical objects

// ── parsing ──────────────────────────────────────────────────────────────────

/** Parse `#rgb` `#rrggbb` `#rrggbbaa` `rgba(r,g,b,a)` → [r, g, b, a?]; else null. */
function parseColor(text) {
  const t = text.trim();
  const fn = t.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const p = fn[1].split(',').map((s) => s.trim());
    if (p.length < 3) return null;
    const rgb = [Number(p[0]), Number(p[1]), Number(p[2])];
    if (rgb.some((v) => !Number.isFinite(v))) return null;
    const a = p.length > 3 ? Number(p[3]) : 1;
    return Number.isFinite(a) ? [...rgb, a] : null;
  }
  const hex = t.match(/^#([0-9a-f]{3,8})$/i);
  if (!hex) return null;
  let h = hex[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const rgb = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return h.length === 8 ? [...rgb, Number.parseInt(h.slice(6, 8), 16) / 255] : rgb;
}

/** Every rule as { selector, body } with comments stripped. */
function* rules() {
  const stripped = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    yield {
      selector: m[1].replaceAll(/\s+/g, ' ').trim(),
      body: m[2],
    };
  }
}

function declaration(body, prop) {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/** The rule's own background as [r,g,b,a] when it is a plain color veil. */
function ownBackground(body) {
  const raw = declaration(body, 'background') ?? declaration(body, 'background-color');
  if (!raw) return null;
  if (raw.includes('var(') || raw.includes('gradient') || raw.includes('color-mix')) return null;
  const c = parseColor(raw);
  return c && c[3] > 0 ? c : null;
}

// ── worst-case computation ───────────────────────────────────────────────────

const GLASS = parseColor(tokenValue('glass-bg'));
const BG_DARK = parseColor(tokenValue('bg-dark'));
const ACCENT = parseColor(tokenValue('accent'));
const GLASS_OVER_WHITE = composite(GLASS, [255, 255, 255]);
const GLASS_OVER_BG_DARK = composite(GLASS, BG_DARK);

function tokenValue(name) {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(m, `style.css :root must declare --${name}`);
  return m[1].trim();
}

/**
 * Worst-case ratio for `color` sitting on `own` (or bare glass), over both
 * the white-imagery and nominal-dark backdrop extremes.
 */
function worstCase(color, own) {
  const worst = (base) => {
    const mid = own ? composite(own, base) : base;
    return contrastRatio(composite(color, mid), mid);
  };
  return Math.min(worst(GLASS_OVER_WHITE), worst(GLASS_OVER_BG_DARK));
}

function enabled(sel) {
  // Disabled controls are exempt under WCAG 1.4.3/1.4.6 — but `:not(:disabled)`
  // selects ENABLED elements, so strip :not(...) before looking for :disabled.
  const withoutNot = sel.replaceAll(/:not\([^)]*\)/g, '');
  return !/:disabled/.test(withoutNot) && !/\[aria-disabled.?=.?.?true/.test(withoutNot);
}

// ── the exemption lists (each entry must keep matching the stylesheet) ──────

// Dark text on the bright --accent fill: their real backdrop is the accent,
// not glass — asserted against ACCENT below, not against the glass stack.
const INVERTED_ON_ACCENT = ['.gev-dialog-confirm', '.pp-mode-btn.active'];

// Glyphs, not text: held to the WCAG 1.4.11 non-text bar (3:1).
const GLYPHS = ['#hud-rec-dot', '#space-mission-panel-host .space-mission-roster-chevron'];

// Pure decoration whose meaning is carried by adjacent text; the arrow's
// hover/focus state (0.9 alpha) IS asserted (>= AAA) so the affordance is
// still bound. The idle alpha is the dimmed resting state by design.
const DECORATIVE = ['.first-run-arrow'];

// ── the audit ────────────────────────────────────────────────────────────────

test('every literal text color clears WCAG AAA (7:1) in the worst case', () => {
  const failures = [];
  const seenInverted = new Set();
  const seenGlyphs = new Set();
  const seenDecorative = new Set();

  for (const { selector, body } of rules()) {
    const colorRaw = declaration(body, 'color');
    if (!colorRaw || colorRaw.includes('var(')) continue;
    const color = parseColor(colorRaw);
    if (!color) continue; // currentColor / inherit / transparent / keywords

    if (INVERTED_ON_ACCENT.some((s) => selector.includes(s))) {
      if (color) seenInverted.add(selector);
      continue; // asserted separately, against ACCENT
    }
    if (GLYPHS.some((s) => selector.includes(s))) {
      if (color) seenGlyphs.add(selector);
      continue; // asserted separately, against the 3:1 bar
    }
    if (DECORATIVE.some((s) => selector.includes(s))) {
      seenDecorative.add(selector);
      continue; // hover state asserted separately
    }
    if (!enabled(selector)) continue; // WCAG disabled-control exception

    const worst = worstCase(color, ownBackground(body));
    if (worst < AAA_TEXT) {
      failures.push(`${selector}\n    color: ${colorRaw} computes ${worst.toFixed(2)}:1 worst case (< ${AAA_TEXT}:1)`);
    }
  }

  assert.deepEqual(
    [...seenInverted].sort(),
    [...INVERTED_ON_ACCENT].sort(),
    'inverted-on-accent exemption list must exactly match the stylesheet',
  );
  assert.deepEqual(
    [...seenGlyphs].sort(),
    [...GLYPHS].sort(),
    'glyph exemption list must exactly match the stylesheet',
  );
  assert.ok(
    seenDecorative.size >= DECORATIVE.length,
    'decorative exemption list must keep matching the stylesheet',
  );
  assert.deepEqual(failures, [], `${failures.length} literal text color(s) below AAA`);
});

test('inverted accent buttons keep >= AAA dark-on-accent text', () => {
  for (const { selector, body } of rules()) {
    if (!INVERTED_ON_ACCENT.some((s) => selector.includes(s))) continue;
    const colorRaw = declaration(body, 'color');
    if (!colorRaw) continue; // :hover etc. siblings — the base rule carries the color
    const color = parseColor(colorRaw);
    assert.ok(color, `${selector} must declare a literal color`);
    const worst = contrastRatio(composite(color, ACCENT), ACCENT);
    assert.ok(
      worst >= AAA_TEXT,
      `${selector} dark-on-accent computes ${worst.toFixed(2)}:1 (< ${AAA_TEXT}:1)`,
    );
  }
});

test('glyph colors clear the WCAG 1.4.11 non-text bar (3:1)', () => {
  for (const { selector, body } of rules()) {
    if (!GLYPHS.some((s) => selector.includes(s))) continue;
    const color = parseColor(declaration(body, 'color'));
    assert.ok(color, `${selector} must declare a literal color`);
    const worst = worstCase(color, ownBackground(body));
    assert.ok(worst >= NON_TEXT, `${selector} computes ${worst.toFixed(2)}:1 (< ${NON_TEXT}:1 non-text)`);
  }
});

test('decorative arrow keeps an AAA hover/focus affordance', () => {
  const hovered = [...rules()].filter(({ selector }) =>
    DECORATIVE.some((s) => selector.includes(s)) && /(hover|focus-visible)/.test(selector),
  );
  assert.ok(hovered.length > 0, 'the decorative arrow must keep a hover/focus rule');
  for (const { selector, body } of hovered) {
    const color = parseColor(declaration(body, 'color'));
    assert.ok(color, `${selector} must declare a literal color`);
    const worst = worstCase(color, ownBackground(body));
    assert.ok(worst >= AAA_TEXT, `${selector} hover computes ${worst.toFixed(2)}:1 (< ${AAA_TEXT}:1)`);
  }
});

test('status hues never regress below their Batch-F replacements', () => {
  // The families the codemod normalized; if a rule reintroduces a dimmer
  // variant of these hues this catches the regression even if a new selector
  // shape dodges the generic audit (e.g. inside a shadow-DOM template string).
  const floors = [
    [/#ff5c6e\b/i, 'error red must stay >= #ff9da8'],
    [/#ff6b6b\b/i, 'error red must stay >= #ffa0a0'],
    [/#ff7272\b/i, 'danger hover must stay >= #ffb8b8'],
    [/#ff7e7e\b/i, 'danger hover must stay >= #ffa0a0'],
    [/#ff8585\b/i, 'unavailable red must stay >= #ffacac'],
    [/#ff8f9d\b/i, 'error header red must stay >= #ff9ca9'],
    [/#517f84\b/i, 'tuner dim cyan must stay >= #a8bfc2'],
    [/#8192a6\b/i, 'standby slate must stay >= #b1bbc8'],
    [/#6daeb5\b/i, 'tuner header cyan must stay >= #90c1c7'],
    [/#d5a863\b/i, 'warning amber must stay >= #dab276'],
  ];
  for (const [pattern, message] of floors) {
    assert.doesNotMatch(css, pattern, message);
  }
});
