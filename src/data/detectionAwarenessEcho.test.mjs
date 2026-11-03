// src/data/detectionAwarenessEcho.test.mjs — Global Context sonar echoes pulse
// a contact's own detection bracket: a second bracket that starts on it and
// spreads outward as it fades. Exercises the renderer's actual echo block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as Cesium from 'cesium';
import {
  awarenessEchoAt,
  clearAwarenessEchoField,
  setAwarenessEchoField,
} from '../awarenessEcho.js';

const source = readFileSync(new URL('./detection.js', import.meta.url), 'utf8');
const echoBlock = source.match(
  /if \(echoPaths\) \{\s*const echo = awarenessEchoAt[\s\S]*?\n {6}\}\n/,
)?.[0];

const pulse = { count: 3, periodMs: 9000, startFraction: 0.02 };
const echo = {
  fadeMs: 1400,
  layerIds: ['flights', 'military', 'ais-live-vessels'],
  spreadPx: 8,
};

/** Run the renderer's echo block for one contact and record the bracket. */
function paintEcho(field, obj, now, { admissionAlpha = 1 } = {}) {
  const brackets = [];
  const state = {
    echoPaths: field ? new Array(9) : null,
    echoField: field,
    ECHO_ALPHA_STEPS: 8,
    awarenessEchoAt,
    Path2D: class {},
    appendCornerBracket: (sink, sx, sy, halfW, halfH) =>
      brackets.push({ sink, sx, sy, halfW, halfH }),
    obj,
    now,
    admissionAlpha,
    sx: 100,
    sy: 50,
    halfW: 9,
    halfH: 7,
  };
  vm.runInNewContext(echoBlock, state);
  const band = state.echoPaths?.findIndex((path) => path) ?? -1;
  return { brackets, band };
}

test('the echo bracket pulses outward from the contact bracket and fades', (t) => {
  assert.ok(echoBlock, 'renderer has an echo block');
  t.after(clearAwarenessEchoField);
  const center = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  const field = { center, radiusM: 250_000, pulse, echo };
  setAwarenessEchoField(field);
  const position = Cesium.Cartesian3.fromDegrees(3.5, 27, 10_000);
  const ground = Cesium.Cartesian3.fromDegrees(3.5, 27, 0);
  const d = Cesium.Cartesian3.distance(center, ground);
  const arrival =
    ((d / 250_000 - pulse.startFraction) / (1 - pulse.startFraction)) *
      pulse.periodMs +
    pulse.periodMs * 3;
  const obj = { _layerId: 'flights', position };

  // The moment the front arrives: on the bracket, strongest band.
  const fresh = paintEcho(field, obj, arrival);
  assert.equal(fresh.brackets.length, 1);
  assert.ok(fresh.brackets[0].halfW - 9 < 0.01);
  assert.equal(fresh.band, 8);
  // Half way through the fade: dimmer and spread outward.
  const half = paintEcho(field, obj, arrival + echo.fadeMs / 2);
  assert.ok(half.brackets[0].halfW > 9 + echo.spreadPx * 0.5);
  assert.ok(half.brackets[0].halfH > 7 + echo.spreadPx * 0.5);
  assert.equal(half.brackets[0].sx, 100);
  assert.ok(half.band < 8 && half.band >= 1);
  // Keyhole fade carries over to the echo.
  assert.ok(paintEcho(field, obj, arrival, { admissionAlpha: 0.25 }).band <= 2);
  // Faded out, or between fronts: no echo bracket.
  assert.equal(
    paintEcho(field, obj, arrival + echo.fadeMs + 5).brackets.length,
    0,
  );
});

test('no echo field, or a layer that does not echo, draws nothing extra', (t) => {
  assert.ok(echoBlock);
  t.after(clearAwarenessEchoField);
  const center = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  const position = Cesium.Cartesian3.fromDegrees(3.01, 27, 0);
  // No field: the renderer skips the echo block entirely.
  assert.equal(
    paintEcho(null, { _layerId: 'flights', position }, 0).brackets.length,
    0,
  );
  const field = { center, radiusM: 250_000, pulse, echo };
  setAwarenessEchoField(field);
  for (let now = 0; now < pulse.periodMs; now += 25)
    for (const layerId of ['cctv', 'satellites', 'traffic'])
      assert.equal(
        paintEcho(field, { _layerId: layerId, position }, now).brackets.length,
        0,
      );
});
