import assert from 'node:assert/strict';
import test from 'node:test';
import { bloomStrengthFromIntensity } from '../../bloom.js';
import {
  BLOOM_DEAD_ZONE,
  bloomSettingsFromStrength,
  createBloomPort,
  easedBloomStrength,
} from './bloomSettings.js';

const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual}`);

test('the strength eases above the dead zone as Cesium bloom stage does', () => {
  assert.equal(BLOOM_DEAD_ZONE, 0.06);
  assert.equal(easedBloomStrength(0), 0);
  assert.equal(easedBloomStrength(0.06), 0);
  assert.equal(easedBloomStrength(1), 1);
  assert.equal(easedBloomStrength(2), 1, 'clamped');
  assert.equal(easedBloomStrength(Number.NaN), 0);
  // VisualEffects.applyBloomIntensity: (s - 0.06) / 0.94, smoothstepped.
  const s = bloomStrengthFromIntensity(100);
  const t = (s - 0.06) / 0.94;
  close(easedBloomStrength(s), t * t * (3 - 2 * t), 'slider 100');
});

test('a stronger bloom lowers the threshold and widens and strengthens the glow', () => {
  const weak = bloomSettingsFromStrength(0.2);
  const strong = bloomSettingsFromStrength(1);
  assert.ok(strong.luminanceThreshold < weak.luminanceThreshold);
  assert.ok(strong.luminanceSmoothing > weak.luminanceSmoothing);
  assert.ok(strong.radius > weak.radius);
  assert.ok(strong.intensity > weak.intensity);
  // The threshold is display 0.92..0.72 in the linear terms Navara holds.
  const linear = (v) => ((v + 0.055) / 1.055) ** 2.4;
  close(bloomSettingsFromStrength(0).luminanceThreshold, linear(0.92), 'off');
  close(strong.luminanceThreshold, linear(0.72), 'full');
  assert.equal(strong.eased, 1);
});

test('the bloom port adds the effect when it first glows and hides it after', () => {
  const added = [];
  const updates = [];
  let deleted = 0;
  const port = createBloomPort((settings) => {
    added.push(settings);
    return {
      update: (next) => updates.push(next),
      delete: () => deleted++,
    };
  });
  port.set({ enabled: true, strength: 0.05 });
  port.set({ enabled: false, strength: 1 });
  assert.equal(added.length, 0, 'no glow, no pass');
  port.set({ enabled: true, strength: 1 });
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], bloomSettingsFromStrength(1));
  assert.equal(port.shown(), true);
  port.set({ enabled: true, strength: 0.03 });
  assert.equal(port.shown(), false, 'the dead zone hides it');
  port.set({ enabled: true, strength: 0.5 });
  port.set({ enabled: false, strength: 0.5 });
  assert.deepEqual(
    updates.map(({ visible }) => visible),
    [false, true, false],
  );
  assert.deepEqual(updates[1].settings, bloomSettingsFromStrength(0.5));
  port.destroy();
  port.destroy();
  assert.equal(deleted, 1);
});
