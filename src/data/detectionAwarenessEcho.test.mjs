// src/data/detectionAwarenessEcho.test.mjs — Global Context sonar echoes pulse
// a contact's own detection bracket: a second bracket that starts on it and
// spreads outward as it fades, in the detection style's own colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  awarenessEchoBracket,
  awarenessEchoColor,
  clearAwarenessEchoField,
  setAwarenessEchoField,
} from '../awarenessEcho.js';
import { DETECTION_THEME_MAP } from '../overlays/worldOverlayTokens.js';

const STEPS = 8;
const pulse = { count: 3, periodMs: 9000, startFraction: 0.02 };
const echo = {
  fadeMs: 1400,
  layerIds: ['flights', 'military', 'ais-live-vessels'],
  spreadPx: 8,
  color: 'rgb(98, 181, 255)',
};
const center = Cesium.Cartesian3.fromDegrees(3, 27, 0);
const field = { center, radiusM: 250_000, pulse, echo };

/** The moment pulse 0's front reaches the ground under `position`. */
function arrivalAt(position) {
  const ground = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(position);
  const d = Cesium.Cartesian3.distance(center, ground);
  return (
    ((d / 250_000 - pulse.startFraction) / (1 - pulse.startFraction)) *
      pulse.periodMs +
    pulse.periodMs * 3
  );
}

test('the echo bracket pulses outward from the contact bracket and fades', (t) => {
  t.after(clearAwarenessEchoField);
  setAwarenessEchoField(field);
  const position = Cesium.Cartesian3.fromDegrees(3.5, 27, 10_000);
  const arrival = arrivalAt(position);
  const at = (nowMs, bracketAlpha = 1) =>
    awarenessEchoBracket('flights', position, nowMs, bracketAlpha, STEPS);

  // The moment the front arrives: on the bracket, strongest band.
  const fresh = at(arrival);
  assert.ok(fresh);
  assert.ok(Math.abs(fresh.spreadPx) < 0.01, `${fresh.spreadPx}`);
  assert.equal(fresh.band, STEPS);
  // Half way through the fade: dimmer and spread outward, but not past
  // the field's spread.
  const half = at(arrival + echo.fadeMs / 2);
  assert.ok(half.spreadPx > echo.spreadPx * 0.5);
  assert.ok(half.spreadPx < echo.spreadPx);
  assert.ok(half.band < STEPS && half.band >= 1);
  // The bracket's own dimming (keyhole fade, Cyber sonar sweep) carries
  // over, and the echo is never drawn brighter than its bracket: a bracket
  // too dim for even one band draws no echo.
  assert.equal(at(arrival, 0.25).band, 2);
  assert.equal(at(arrival, 0.05), null);
  for (let alpha = 0.05; alpha <= 1; alpha += 0.05) {
    const echoed = at(arrival + echo.fadeMs / 3, alpha);
    if (echoed)
      assert.ok(
        echoed.band / STEPS <= alpha + 0.5 / STEPS + 1e-9,
        `band ${echoed.band} for a bracket at ${alpha}`,
      );
  }
  // Faded out, or between fronts: no echo bracket.
  assert.equal(at(arrival + echo.fadeMs + 5), null);
});

test('no echo field, or a layer that does not echo, draws nothing extra', (t) => {
  t.after(clearAwarenessEchoField);
  const position = Cesium.Cartesian3.fromDegrees(3.01, 27, 0);
  clearAwarenessEchoField();
  for (let now = 0; now < pulse.periodMs; now += 25)
    assert.equal(
      awarenessEchoBracket('flights', position, now, 1, STEPS),
      null,
    );
  setAwarenessEchoField(field);
  for (let now = 0; now < pulse.periodMs; now += 25)
    for (const layerId of ['cctv', 'satellites', 'traffic'])
      assert.equal(
        awarenessEchoBracket(layerId, position, now, 1, STEPS),
        null,
      );
});

test('echoes take the detection style colour except on the default style', (t) => {
  t.after(clearAwarenessEchoField);
  assert.equal(
    awarenessEchoColor(DETECTION_THEME_MAP._default.line, true),
    null,
  );
  setAwarenessEchoField(field);
  assert.equal(
    awarenessEchoColor(DETECTION_THEME_MAP._default.line, true),
    echo.color,
  );
  // CRT, NVG and FLIR keep their monochrome palettes.
  for (const style of ['retro', 'surveillance', 'thermal']) {
    const { line } = DETECTION_THEME_MAP[style];
    assert.equal(awarenessEchoColor(line, false), line, style);
  }
});
