// src/layers/traffic/style.test.mjs — the traffic layer keeps its dot
// colours as renderer colours and paints them onto the points' items as the
// colours they always were.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createStyle } from './style.js';
import {
  FLOW_BUCKET_COLORS,
  JAM_DOT_FAR_SCALE,
  SIM_DOT_COLOR,
} from './policy.js';
import { presetDotRgba } from '../../data/trafficPresetStyle.js';
import { createState } from './state.js';

/** A renderer colour (`[r, g, b, a]`) as Cesium draws it. */
const asColor = (rgba) => new Cesium.Color(...rgba);

function style(preset = 'normal') {
  const state = createState({ services: {} });
  state._stylePreset = preset;
  const parts = {};
  parts.style = createStyle({ state, services: {}, parts, source: {} });
  parts.style.refreshBucketColors();
  return { state, style: parts.style };
}

test('bucket colours are the shipped palette, painted as before', () => {
  const { state, style: s } = style();
  assert.deepEqual(state._activeBucketColors.free, FLOW_BUCKET_COLORS.free);
  const expected = {
    free: Cesium.Color.fromCssColorString('#2ecc71').withAlpha(0.9),
    slow: Cesium.Color.fromCssColorString('#f0b23e').withAlpha(0.9),
    jam: Cesium.Color.fromCssColorString('#e05252').withAlpha(0.9),
  };
  for (const bucket of ['free', 'slow', 'jam'])
    assert.ok(
      Cesium.Color.equals(asColor(s.dotColor(bucket)), expected[bucket]),
      bucket,
    );
  assert.ok(
    Cesium.Color.equals(
      asColor(s.dotColor(null)),
      Cesium.Color.WHITE.withAlpha(0.85),
    ),
  );
  assert.deepEqual(SIM_DOT_COLOR, [1, 1, 1, 0.85]);
  assert.equal(s.dotColor('jam'), s.dotColor('jam'), 'one colour per bucket');
});

test('a dot is painted, shown and emphasised on its point', () => {
  const { state, style: s } = style();
  state._fadeScaleFar = 9000;
  const dot = { point: { show: true, color: null } };
  s.paintDot(dot, 'slow');
  assert.equal(dot.point.color, s.dotColor('slow'));
  s.showDot(dot, false);
  assert.equal(dot.point.show, false);
  s.emphasizeJamDot(dot);
  assert.deepEqual(dot.point.scaleByDistance, {
    near: 100,
    nearValue: 1.5,
    far: 9000,
    farValue: JAM_DOT_FAR_SCALE,
  });
});

test('a styled preset recolours the buckets', () => {
  const { state, style: s } = style('surveillance');
  const before = FLOW_BUCKET_COLORS.jam;
  assert.notDeepEqual(state._activeBucketColors.jam, before);
  assert.equal(state._activeBucketColors.jam.length, 4);
  const [r, g, b, a] = presetDotRgba('surveillance', 'jam');
  assert.ok(
    Cesium.Color.equals(
      asColor(s.dotColor('jam')),
      new Cesium.Color(r / 255, g / 255, b / 255, a),
    ),
  );
});

test('switching presets and back repaints dots with the shipped colours', () => {
  const state = createState({ services: {} });
  const parts = {
    rendering: { rebuildHeatLines() {}, visibleRoadsForAltitude: () => [] },
  };
  parts.style = createStyle({ state, services: {}, parts, source: {} });
  parts.style.refreshBucketColors();
  const dot = { bucket: 'free', road: { type: 'primary' }, point: {} };
  state._dots = [dot];
  const shipped = Cesium.Color.fromCssColorString('#2ecc71').withAlpha(0.9);
  parts.style.setStylePreset('surveillance');
  assert.ok(!Cesium.Color.equals(asColor(dot.point.color), shipped));
  assert.equal(dot.point.color, parts.style.dotColor('free'));
  parts.style.setStylePreset('normal');
  assert.ok(Cesium.Color.equals(asColor(dot.point.color), shipped));
  assert.deepEqual(state._activeBucketColors.free, FLOW_BUCKET_COLORS.free);
});
