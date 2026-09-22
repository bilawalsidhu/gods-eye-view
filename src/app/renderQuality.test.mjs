// Render-quality preset resolution and application. Pure/dependency-injected;
// no DOM, no Cesium, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRenderQuality,
  RENDER_QUALITY_DEFAULT,
  RENDER_QUALITY_NAMES,
  RENDER_QUALITY_PRESETS,
  renderQualityPreset,
  resolveRenderQualityName,
} from './renderQuality.js';

function fakeViewer() {
  return { resolutionScale: 1.0, scene: { msaaSamples: 4 } };
}

test('the default preset reproduces the shipped viewer settings exactly', () => {
  // Guards the whole point of this module: adding it must not change what
  // anyone sees unless they opt in. These two values mirror the literals in
  // src/app/viewer.js (msaaSamples: 4) and Cesium's own resolutionScale
  // default of 1.0.
  const preset = RENDER_QUALITY_PRESETS[RENDER_QUALITY_DEFAULT];
  assert.equal(preset.msaaSamples, 4);
  assert.equal(preset.resolutionScale, 1.0);
});

test('applying the default to a fresh viewer changes nothing', () => {
  const viewer = fakeViewer();
  applyRenderQuality(viewer, RENDER_QUALITY_DEFAULT);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(viewer.resolutionScale, 1.0);
});

test('no query string, absent param, and empty input all resolve to the default', () => {
  for (const input of [undefined, null, '', '?', '?foo=bar', '?quality=']) {
    assert.equal(
      resolveRenderQualityName(input),
      RENDER_QUALITY_DEFAULT,
      String(input),
    );
  }
});

test('every preset name is accepted, case- and whitespace-insensitively', () => {
  for (const name of RENDER_QUALITY_NAMES) {
    assert.equal(resolveRenderQualityName(`?quality=${name}`), name);
    assert.equal(
      resolveRenderQualityName(`?quality=${name.toUpperCase()}`),
      name,
    );
    assert.equal(resolveRenderQualityName(`?quality=  ${name}  `), name);
  }
});

test('an unknown or hostile value falls back to the default rather than throwing', () => {
  for (const bad of [
    '?quality=ultra',
    '?quality=0',
    '?quality=__proto__',
    '?quality=constructor',
    '?quality=toString',
    '?quality=' + 'x'.repeat(5000),
  ]) {
    assert.equal(resolveRenderQualityName(bad), RENDER_QUALITY_DEFAULT, bad);
  }
});

test('prototype keys cannot smuggle a non-preset through the lookup', () => {
  // `Object.hasOwn` rather than `in`/truthiness: '__proto__' and 'constructor'
  // resolve on a plain object literal and would otherwise yield a "preset"
  // that is a function or Object.prototype.
  for (const key of [
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
  ]) {
    const preset = renderQualityPreset(key);
    assert.equal(preset, RENDER_QUALITY_PRESETS[RENDER_QUALITY_DEFAULT]);
    assert.equal(typeof preset.msaaSamples, 'number');
    assert.equal(typeof preset.resolutionScale, 'number');
  }
});

test('performance preset applies both knobs, which is where the measured win is', () => {
  const viewer = fakeViewer();
  const applied = applyRenderQuality(viewer, 'performance');
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(viewer.resolutionScale, 0.6);
  assert.equal(applied, RENDER_QUALITY_PRESETS.performance);
});

test('balanced sits strictly between high and performance on both axes', () => {
  const { high, balanced, performance } = RENDER_QUALITY_PRESETS;
  assert.ok(performance.msaaSamples < balanced.msaaSamples);
  assert.ok(balanced.msaaSamples < high.msaaSamples);
  assert.ok(performance.resolutionScale < balanced.resolutionScale);
  assert.ok(balanced.resolutionScale < high.resolutionScale);
});

test('every preset is internally sane', () => {
  for (const name of RENDER_QUALITY_NAMES) {
    const p = RENDER_QUALITY_PRESETS[name];
    assert.ok([1, 2, 4, 8].includes(p.msaaSamples), `${name} msaaSamples`);
    assert.ok(
      p.resolutionScale > 0 && p.resolutionScale <= 1,
      `${name} resolutionScale`,
    );
    assert.equal(typeof p.description, 'string');
    assert.ok(p.description.length > 0);
  }
});

test('presets are frozen so a caller cannot mutate them for everyone else', () => {
  assert.throws(() => {
    'use strict';
    RENDER_QUALITY_PRESETS.performance.msaaSamples = 4;
  }, TypeError);
  assert.equal(RENDER_QUALITY_PRESETS.performance.msaaSamples, 1);
});

test('a viewer without a scene is left alone instead of throwing', () => {
  // Startup must never die over a display preference.
  assert.equal(applyRenderQuality(undefined, 'performance'), null);
  assert.equal(applyRenderQuality(null, 'performance'), null);
  assert.equal(applyRenderQuality({}, 'performance'), null);
});

test('a viewer that rejects a value fails soft and reports it', () => {
  const hostile = {
    scene: {
      set msaaSamples(_v) {
        throw new Error('unsupported by this context');
      },
    },
  };
  assert.equal(applyRenderQuality(hostile, 'performance'), null);
});
