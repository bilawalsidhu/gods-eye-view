// src/uiContrast.test.mjs
//
// WCAG 2.1 contrast verification for the console's design tokens (PLAN Phase 4).
// The hard case is HUD text over ARBITRARY imagery: panels float on the globe,
// so the real backdrop under a label ranges from deep space to white cloud/ice.
// The unit for "worst case" here is therefore the full composite stack —
//
//   imagery(white) ← --glass-bg scrim ← text token (with its own alpha)
//
// — not the bare --bg-dark swatch. Measured before the 2026-09-13 fix: the
// old tokens (glass 0.72, text 0.5/0.55) computed 2.96:1 / 3.24:1 in the
// worst case — a real AA failure invisible if you only ever measure the
// token against --bg-dark (where the old --text-dim comment claimed 5.3:1,
// and was true — and useless).
//
// The fix is SCRIM-FIRST by design: strengthen --glass-bg before touching
// text alphas, and never change hue tokens (--accent) — the IR/NVG/FLIR and
// Blade-runner identities live in those hues, not in scrim opacity. These
// tests pin both the ratios and that division of labor.
//
// 2026-09-15 (Batch F): the pins ratcheted AA -> AAA (7:1). At the 0.82
// scrim the identity hue --accent computed 6.8:1 worst case and hue is
// pinned, so the only compliant knob was the scrim: --glass-bg 0.82 -> 0.88,
// text-secondary/dim 0.7 -> 0.78. Computed worst cases now: primary 11.96:1,
// secondary/dim 7.88:1, accent 8.14:1. HUD chrome floating directly on the
// globe (no panel behind it) carries a dark text outline (0 1px 2px #001018)
// as the backdrop bound and --hud-color was raised 0.6 -> 0.85; ratios are
// not computable there (arbitrary imagery), so the outline is pinned
// structurally instead.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readSource } from './testSupport/readSource.js';

const css = readSource('../style.css', import.meta.url);

// ── WCAG 2.1 relative luminance / contrast math ─────────────────────────────
// Shared with src/styleContrastAudit.test.mjs via src/testSupport/contrastMath.js
// (a plain module — importing a .test.mjs would re-run its tests).

import { contrastRatio, composite } from './testSupport/contrastMath.js';

export { contrastRatio, composite };

// ── Token parsing (no hardcoding: the test measures what style.css declares) ─

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `style.css :root must declare --${name}`);
  return match[1].trim();
}

/** Parse `#rrggbb` or `rgba(r, g, b, a)` into [r, g, b, a?]. */
function parseColor(text) {
  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s]+([\d.]+))?\s*\)$/i);
  assert.ok(rgba, `unsupported color syntax: ${text}`);
  const out = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
  if (rgba[4] !== undefined) out.push(Number(rgba[4]));
  return out;
}

const BG_DARK = parseColor(token('bg-dark'));
const GLASS = parseColor(token('glass-bg'));

/** Worst case: the brightest backdrop the globe can put under a panel. */
const GLASS_OVER_WHITE = composite(GLASS, [255, 255, 255]);
/** Nominal dark backdrop: the page background itself. */
const GLASS_OVER_BG_DARK = composite(GLASS, BG_DARK);

/** Contrast of a text token composited over a panel composite. */
function textContrast(tokenName, panel) {
  const text = parseColor(token(tokenName));
  return contrastRatio(composite(text, panel), panel);
}

// ── The pins ─────────────────────────────────────────────────────────────────

test('panel text clears WCAG AAA in the worst case (glass scrim over white imagery)', () => {
  for (const name of ['text-primary', 'text-secondary', 'text-dim', 'accent']) {
    const ratio = textContrast(name, GLASS_OVER_WHITE);
    assert.ok(
      ratio >= 7,
      `--${name} over --glass-bg over white computes ${ratio.toFixed(2)}:1 — ` +
        'below AAA (7:1). Fix scrim-first: raise --glass-bg alpha, not text hue.',
    );
  }
});

test('panel text clears AAA over the nominal dark backdrop too', () => {
  for (const name of ['text-primary', 'text-secondary', 'text-dim', 'accent']) {
    const ratio = textContrast(name, GLASS_OVER_BG_DARK);
    assert.ok(ratio >= 7, `--${name} over --glass-bg over --bg-dark computes ${ratio.toFixed(2)}:1`);
  }
});

test('--text-dim clears AAA directly on --bg-dark (nominal dark backdrop)', () => {
  const text = parseColor(token('text-dim'));
  const ratio = contrastRatio(composite(text, BG_DARK), BG_DARK);
  assert.ok(ratio >= 7, `--text-dim on --bg-dark computes ${ratio.toFixed(2)}:1 — below AAA (7:1)`);
});

test('the fix stays scrim-first: glass alpha ≥ 0.8, identity hue untouched', () => {
  // The worst-case ratios above could also be "reached" by making the text
  // tokens near-opaque — which would wash the dark scenes out and break the
  // look. The mechanism is the panel scrim; pin its floor so a future
  // "tune the alpha back down" cannot silently re-open the AA gap these
  // tests would otherwise only catch via the text side.
  assert.ok(
    GLASS[3] >= 0.85,
    `--glass-bg alpha is ${GLASS[3]} — the AAA worst case is bought with scrim opacity; do not lower it without re-measuring src/uiContrast.test.mjs`,
  );
  // Hue tokens are identity (IR/NVG/FLIR, blade-runner accent) — contrast
  // work must not touch them.
  assert.equal(token('accent').toLowerCase(), '#00d4ff', 'accent hue is identity — do not retint');
});

test('HUD text keeps its legibility shadows and glows (regression anchors)', () => {
  // Shadows are not a WCAG-passing mechanism on their own (the ratios above
  // are), but they are the identity's edge treatment over bright imagery —
  // a mass removal would be a readability regression the ratio pins alone
  // would not explain.
  const shadowCount = (css.match(/text-shadow:/g) || []).length;
  assert.ok(shadowCount >= 20, `style.css has ${shadowCount} text-shadow rules — mass removal is a regression`);
  assert.match(css, /--hud-glow:\s*rgba\(/, 'HUD glow token must stay declared');
  // The dark scratch shadow that keeps HUD text legible over bright tiles.
  assert.match(css, /text-shadow:\s*0 1px 2px #001018/, 'HUD dark outline shadow must stay');
  // Batch F (AAA): HUD chrome floats on the globe with NO panel behind it —
  // its ratio cannot be computed, so the backdrop bound is structural: the
  // #intel-hud base rule must keep the dark outline next to the identity
  // glow, and --hud-color must stay at its raised (0.85) alpha.
  assert.match(
    css,
    /#intel-hud \*\s*{[^}]*text-shadow:\s*0 1px 2px #001018, 0 0 4px var\(--hud-glow\)/,
    '#intel-hud must keep the dark outline beside the glow (globe-floating text has no scrim)',
  );
  const hudColor = parseColor(token('hud-color'));
  assert.ok(hudColor[3] >= 0.85, `--hud-color alpha is ${hudColor[3]} — globe-floating text needs >= 0.85`);
});
