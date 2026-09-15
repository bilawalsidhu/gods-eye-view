import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIT_TIER_KEYS,
  presetSpriteOutlinePx,
  presetSpriteRgba,
  presetSpriteScale,
  transitModeTier,
  transitStyleProfile,
} from './transitPresetStyle.js';
import { TRANSIT_MODES } from './transitFeeds.js';

test('profile mapping: NVG/FLIR/noir and cockpit nvg are mono, retro is crt, everything else normal', () => {
  for (const mono of ['surveillance', 'thermal', 'noir', 'nvg'])
    assert.equal(transitStyleProfile(mono), 'mono', mono);
  assert.equal(transitStyleProfile('retro'), 'crt');
  for (const plain of [
    'normal',
    'anime',
    'snow',
    'minecraft',
    '',
    null,
    undefined,
    'optical',
  ])
    assert.equal(transitStyleProfile(plain), 'normal', String(plain));
});

test('normal uses mode colour, unit scale and a one-pixel halo', () => {
  for (const mode of TRANSIT_MODES) {
    assert.equal(presetSpriteRgba('normal', mode), null);
    assert.equal(presetSpriteRgba(undefined, mode), null);
  }
  assert.equal(presetSpriteScale('normal'), 1);
  assert.equal(presetSpriteOutlinePx('normal'), 1);
});

test('mono: every mode is a white core, larger, with a dark halo in screen pixels', () => {
  for (const style of ['surveillance', 'thermal', 'noir', 'nvg']) {
    for (const mode of TRANSIT_MODES) {
      assert.deepEqual(
        presetSpriteRgba(style, mode),
        [255, 255, 255, 1],
        `${style} ${mode}`,
      );
    }
    assert.ok(presetSpriteScale(style) === 1.4, `${style} is drawn larger`);
    // At least a whole screen pixel and a half of ring around a five-pixel
    // body: thinner than that vanishes through blur and pixelation.
    assert.ok(
      presetSpriteOutlinePx(style) >= 1.5,
      `${style} halo is ${presetSpriteOutlinePx(style)} px`,
    );
  }
});

test('crt: saturated per-mode colours, distinct, upsized, thinner halo', () => {
  const seen = new Set();
  for (const mode of TRANSIT_MODES) {
    const rgba = presetSpriteRgba('retro', mode);
    assert.ok(Array.isArray(rgba) && rgba.length === 4, mode);
    seen.add(rgba.slice(0, 3).join(','));
    const [r, g, b] = rgba;
    assert.ok(
      Math.max(r, g, b) === 255,
      `${mode} is fully saturated on one channel`,
    );
  }
  assert.equal(seen.size, TRANSIT_MODES.length, 'no two modes share a colour');
  assert.ok(presetSpriteScale('retro') > 1.2);
  assert.ok(
    presetSpriteOutlinePx('retro') > 0 &&
      presetSpriteOutlinePx('retro') < presetSpriteOutlinePx('thermal'),
  );
});

test('every mode has its own bracket tier, unknown modes fall to transit_unknown', () => {
  const tiers = new Set();
  for (const mode of TRANSIT_MODES) tiers.add(transitModeTier(mode));
  assert.equal(tiers.size, TRANSIT_MODES.length);
  assert.equal(transitModeTier('spaceship'), 'transit_unknown');
  assert.equal(transitModeTier(undefined), 'transit_unknown');
  assert.deepEqual([...tiers].sort(), [...TRANSIT_TIER_KEYS].sort());
});

test('all styled tuples are valid rgba: channels 0–255 ints, alpha in (0, 1]', () => {
  for (const style of ['thermal', 'retro']) {
    for (const mode of TRANSIT_MODES) {
      const [r, g, b, a] = presetSpriteRgba(style, mode);
      for (const c of [r, g, b])
        assert.ok(Number.isInteger(c) && c >= 0 && c <= 255);
      assert.ok(a > 0 && a <= 1);
    }
  }
});
