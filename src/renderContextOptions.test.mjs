import { readSource } from './testSupport/readSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRenderContextOptions, DEFAULT_MSAA_SAMPLES } from './renderContextOptions.js';

/**
 * Render-perf five, items 1–2 (docs/PLAN.md): the Cesium context starts at
 * MSAA 2× with an unpreserved drawing buffer. Every relaxation here was a
 * real per-frame cost measured by scripts/profile-render-perf.mjs:
 *   - preserveDrawingBuffer kept a preserved back buffer + compositor copy
 *     alive for a pixel reader (voice vision) that captures same-task and
 *     provably does not need it (FRAME-CAPTURED with the attribute off).
 *   - 4× MSAA held a 19.8 MiB multisample buffer and its resolve bandwidth
 *     for tile imagery that 2× renders just as cleanly.
 */

test('defaults: MSAA 2, drawing buffer not preserved', () => {
  const options = resolveRenderContextOptions({ search: '' });
  assert.equal(options.msaaSamples, 2);
  assert.equal(DEFAULT_MSAA_SAMPLES, 2);
  assert.deepEqual(options.contextOptions, { webgl: { preserveDrawingBuffer: false } });
});

test('no query string at all resolves the same defaults', () => {
  // The module defaults `search` to the live location; when absent (tests,
  // workers) it must behave like an empty string, not throw.
  const saved = globalThis.location;
  delete globalThis.location;
  try {
    assert.deepEqual(resolveRenderContextOptions(), resolveRenderContextOptions({ search: '' }));
  } finally {
    if (saved !== undefined) globalThis.location = saved;
  }
});

test('?msaa forces the sample count and clamps to a sane range', () => {
  assert.equal(resolveRenderContextOptions({ search: '?msaa=4' }).msaaSamples, 4);
  assert.equal(resolveRenderContextOptions({ search: '?msaa=1' }).msaaSamples, 1);
  assert.equal(resolveRenderContextOptions({ search: '?msaa=2.6' }).msaaSamples, 3);
  assert.equal(resolveRenderContextOptions({ search: '?msaa=99' }).msaaSamples, 8);
  assert.equal(resolveRenderContextOptions({ search: '?msaa=0' }).msaaSamples, 2, '0 is not a sample count');
  assert.equal(resolveRenderContextOptions({ search: '?msaa=nope' }).msaaSamples, 2, 'garbage falls back');
});

test('?preserveBuffer=1 is the only spelling that restores preservation', () => {
  assert.equal(
    resolveRenderContextOptions({ search: '?preserveBuffer=1' }).contextOptions.webgl.preserveDrawingBuffer,
    true,
  );
  assert.equal(
    resolveRenderContextOptions({ search: '?preserveBuffer=true' }).contextOptions.webgl.preserveDrawingBuffer,
    false,
  );
});

test('main.js spreads the resolved options instead of hand-rolling attributes', () => {
  const source = readSource('./main.js', import.meta.url);
  assert.match(source, /import \{ resolveRenderContextOptions \} from '\.\/renderContextOptions\.js';/);
  assert.match(source, /\.\.\.resolveRenderContextOptions\(\),/);
  assert.doesNotMatch(source, /msaaSamples: 4|preserveDrawingBuffer: true/,
    'the old always-on attributes must not creep back into the viewer literal');
});

test('the persistent boot surfaces stay de-blurred (render-perf five, item 3)', () => {
  const css = readSource('../style.css', import.meta.url);
  // These rules once carried backdrop-filter over the always-visible dock
  // and rails — 6.1 MiB of compositor blur reads per rendered frame at
  // boot. The policy comment on #gev-voice-control explains why they must
  // not come back.
  const ruleFor = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} rule exists`);
    const end = css.indexOf('}', start);
    // Strip comments: the policy notes themselves mention backdrop-filter.
    return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  };
  for (const selector of [
    '#gev-voice-control',
    '.panel-inner',
    '.location-inner',
    '.data-panel-inner',
    '#command-dock',
  ]) {
    assert.doesNotMatch(ruleFor(selector), /backdrop-filter/,
      `${selector} is a persistent surface — it must not gain a backdrop-filter`);
  }
  assert.match(css, /#command-dock > #location-bar,[\s\S]*?#command-dock > #control-panel \{[^}]*background: rgba\(12, 12, 20, 0\.92\)/);
  assert.doesNotMatch(
    css.match(/#command-dock > #location-bar,[\s\S]*?\{[^}]*\}/)[0],
    /backdrop-filter/,
  );
});
