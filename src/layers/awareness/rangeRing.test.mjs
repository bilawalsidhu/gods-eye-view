// src/layers/awareness/rangeRing.test.mjs — the 250 km Global Context range
// ring is a haloed polyline that stays legible on light and dark ground,
// sits where the old ellipse outline did, and follows the subject.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { AWARENESS_RADIUS_M } from '../../data/militaryAwarenessEngine.js';
import { AWARENESS_RANGE_RING_STYLE, CONTEXT_RIM_HEIGHT_M } from './policy.js';
import { awarenessRangeRingPositions, createRendering } from './rendering.js';
import { createState } from './state.js';

/** WCAG relative luminance of a Cesium colour, ignoring alpha. */
function luminance(color) {
  const channel = (c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * channel(color.red) +
    0.7152 * channel(color.green) +
    0.0722 * channel(color.blue)
  );
}

/** The rendering part over a bare entity collection, counting render asks. */
function ringRendering() {
  const state = createState({ services: {} });
  const entities = new Cesium.EntityCollection();
  state.viewer = { entities };
  let renders = 0;
  const rendering = createRendering({
    state,
    services: {
      geometry: {},
      render: {
        governorRequestRender() {
          renders += 1;
        },
      },
    },
    parts: {},
  });
  return { entities, rendering, renders: () => renders };
}

/** Surface distance from `center` to each ring position. */
function surfaceDistances(center, positions) {
  const from = Cesium.Cartographic.fromCartesian(center);
  return positions.map((position) => {
    const to = Cesium.Cartographic.fromCartesian(position);
    return new Cesium.EllipsoidGeodesic(from, to).surfaceDistance;
  });
}

for (const [place, lat, lon] of [
  ['equator', 0, 0],
  ['Sahara', 27, 3],
  ['Greenland', 72, -40],
  ['antimeridian', 10, 179.9],
]) {
  test(`ring positions stay 250 km from the subject at ${place}`, () => {
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    const positions = awarenessRangeRingPositions(
      center,
      AWARENESS_RADIUS_M,
      CONTEXT_RIM_HEIGHT_M,
    );
    assert.equal(positions.length, AWARENESS_RANGE_RING_STYLE.segments + 1);
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(positions[0], positions.at(-1), 0, 1e-6),
      'the ring closes on itself',
    );
    // Within 100 m of 250 km on the WGS84 ellipsoid.
    for (const distance of surfaceDistances(center, positions))
      assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100, `${distance} m`);
    for (const position of positions)
      assert.ok(
        Math.abs(
          Cesium.Cartographic.fromCartesian(position).height -
            CONTEXT_RIM_HEIGHT_M,
        ) < 1e-3,
      );
  });
}

test('the ring core and halo contrast on light and dark ground', () => {
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  const halo = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.outlineColor,
  );
  // Core against halo is the edge that survives bright desert and snow, and
  // the monochrome styles that map everything to luminance.
  const ratio = (luminance(core) + 0.05) / (luminance(halo) + 0.05);
  assert.ok(ratio >= 4.5, `core:halo contrast ${ratio.toFixed(2)}`);
  assert.ok(core.alpha >= 0.9 && halo.alpha >= 0.7);
  // A visible halo on each side of a core at least 2 px wide.
  const { width, outlineWidth } = AWARENESS_RANGE_RING_STYLE;
  assert.ok(outlineWidth >= 1);
  assert.ok(width - 2 * outlineWidth >= 2);
});

test('renderVisual draws one haloed polyline ring, not an ellipse outline', () => {
  const { entities, rendering } = ringRendering();
  const subject = {
    layerId: 'flights',
    id: 'abc123',
    position: Cesium.Cartesian3.fromDegrees(3, 27, 9000),
  };
  rendering.renderVisual(subject);
  assert.equal(entities.values.length, 1);
  const [entity] = entities.values;
  assert.equal(entity.ellipse, undefined);
  const now = Cesium.JulianDate.now();
  assert.equal(entity.polyline.width.getValue(now), 4);
  assert.equal(entity.polyline.arcType.getValue(now), Cesium.ArcType.NONE);
  const material = entity.polyline.material;
  assert.ok(material instanceof Cesium.PolylineOutlineMaterialProperty);
  assert.equal(
    material.color.getValue(now).toCssColorString(),
    Cesium.Color.fromCssColorString(
      AWARENESS_RANGE_RING_STYLE.color,
    ).toCssColorString(),
  );
  assert.equal(
    material.outlineWidth.getValue(now),
    AWARENESS_RANGE_RING_STYLE.outlineWidth,
  );
  const ground = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  for (const distance of surfaceDistances(
    ground,
    entity.polyline.positions.getValue(now),
  ))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
});

test('the ring follows the subject past 250 m and ignores smaller drift', () => {
  const { entities, rendering, renders } = ringRendering();
  const subject = (lon) => ({
    layerId: 'flights',
    id: 'abc123',
    position: Cesium.Cartesian3.fromDegrees(lon, 27, 9000),
  });
  rendering.renderVisual(subject(3));
  const [entity] = entities.values;
  const now = Cesium.JulianDate.now();
  const first = entity.polyline.positions.getValue(now);
  const rendersAfterAdd = renders();

  // ~100 m east: under the threshold, nothing is rebuilt or rendered.
  rendering.renderVisual(subject(3.001));
  assert.equal(entity.polyline.positions.getValue(now), first);
  assert.equal(renders(), rendersAfterAdd);

  // ~1 km east: the same entity moves to the new centre.
  rendering.renderVisual(subject(3.01));
  assert.equal(entities.values.length, 1);
  assert.equal(entities.values[0], entity);
  const moved = entity.polyline.positions.getValue(now);
  assert.notEqual(moved, first);
  for (const distance of surfaceDistances(
    Cesium.Cartesian3.fromDegrees(3.01, 27, 0),
    moved,
  ))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
  assert.equal(renders(), rendersAfterAdd + 1);

  rendering.clearVisual();
  assert.equal(entities.values.length, 0);
});
