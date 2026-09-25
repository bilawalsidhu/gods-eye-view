/**
 * Two-character share tokens.
 *
 * The registry's one-character token space ran out: at 28 layers every letter
 * is taken and only digits remain. Widening the grammar is the whole change —
 * the codec splits `l` on `.` and looks each piece up in a map, so token width
 * was never load-bearing.
 *
 * These tests pin the two properties that make it safe to ship: every existing
 * link keeps decoding (so no `v` bump), and the length cap was raised to match
 * the wider tokens (so an all-layers-on link cannot silently fail closed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_STATE_VERSION,
  LAYER_STATE_REGISTRY,
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  validateLayerStateRegistry,
} from './layerState.js';

const base = (extra = []) => [
  { id: 'alpha', token: 'a', disposition: 'enabled-only' },
  ...extra,
];

test('the registry accepts a two-character token', () => {
  assert.equal(
    validateLayerStateRegistry(
      base([{ id: 'bravo', token: 'aa', disposition: 'enabled-only' }]),
    ),
    true,
  );
});

test('one- and two-character tokens coexist in one registry', () => {
  assert.equal(
    validateLayerStateRegistry(
      base([
        { id: 'bravo', token: 'zz', disposition: 'enabled-only' },
        { id: 'charlie', token: '7', disposition: 'enabled-only' },
      ]),
    ),
    true,
  );
});

test('three characters are still rejected', () => {
  // The widening is deliberate and bounded, not open-ended: a longer token
  // would blow the length budget the cap now assumes.
  assert.throws(
    () =>
      validateLayerStateRegistry(
        base([{ id: 'bravo', token: 'aaa', disposition: 'enabled-only' }]),
      ),
    /Invalid layer-state token/,
  );
});

test('an empty or non-alphanumeric token is still rejected', () => {
  for (const token of ['', 'A', 'a-', '.', 'a.']) {
    assert.throws(
      () =>
        validateLayerStateRegistry(
          base([{ id: 'bravo', token, disposition: 'enabled-only' }]),
        ),
      /Invalid layer-state token/,
    );
  }
});

test('duplicate detection still works across widths', () => {
  assert.throws(
    () =>
      validateLayerStateRegistry([
        { id: 'alpha', token: 'ab', disposition: 'enabled-only' },
        { id: 'bravo', token: 'ab', disposition: 'enabled-only' },
      ]),
    /Duplicate layer-state token/,
  );
});

test('every shipped token still satisfies the widened grammar', () => {
  // Guards against the widening masking a bad entry that the old, stricter
  // pattern would have caught.
  for (const entry of LAYER_STATE_REGISTRY) {
    assert.match(entry.token, /^[a-z0-9]{1,2}$/, `bad token on ${entry.id}`);
  }
  assert.equal(validateLayerStateRegistry(), true);
});

test('an all-layers-enabled link fits inside the raised cap', () => {
  // The regression this change prevents. Past the cap the decoder returns null
  // and the whole layer payload is dropped — the link opens and restores
  // nothing, with no error surfaced.
  const state = createDefaultLayerState();
  state.enabledLayerIds = LAYER_STATE_REGISTRY.map((e) => e.id);
  const params = new URLSearchParams();
  params.set('v', String(LAYER_STATE_VERSION));
  encodeLayerStateParams(params, state);
  const decoded = decodeLayerStateParams(params);
  assert.ok(decoded, 'an every-layer link must still decode');
  assert.deepEqual(
    new Set(decoded.enabledLayerIds),
    new Set(LAYER_STATE_REGISTRY.map((e) => e.id)),
  );
});

test('the cap still fails closed on a genuinely oversized payload', () => {
  const params = new URLSearchParams();
  params.set('v', String(LAYER_STATE_VERSION));
  params.set('l', 'a'.repeat(257));
  assert.equal(decodeLayerStateParams(params), null);
});

test('headroom is real, not marginal', () => {
  // N layers encode as 3N-1 characters at two chars per token.
  const clears = Math.floor((256 + 1) / 3);
  assert.ok(
    clears > LAYER_STATE_REGISTRY.length * 2,
    `cap should clear well past today's ${LAYER_STATE_REGISTRY.length} layers, clears ${clears}`,
  );
});
