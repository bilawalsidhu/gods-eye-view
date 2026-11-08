import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { vesselViewArea } from './cameraArea.js';

/** A viewer whose camera and query ports answer as given. */
function viewerWith({ height, lon = 4, lat = 52, hit, size = [1600, 900] }) {
  const viewer = {
    get canvas() {
      return this.scene?.canvas;
    },
    scene: { canvas: { clientWidth: size[0], clientHeight: size[1] } },
  };
  const picks = [];
  const unbind = bindRenderer(viewer, {
    camera: { pose: () => ({ lon, lat, height }) },
    query: {
      pickEllipsoid(x, y) {
        picks.push([x, y]);
        if (hit instanceof Error) throw hit;
        return hit ?? null;
      },
    },
  });
  return { viewer, picks, unbind };
}

test('the view area centres on the ground in the middle of the screen', () => {
  const { viewer, picks, unbind } = viewerWith({
    height: 120000,
    hit: fromDegrees(3.5, 51.25),
  });
  const area = vesselViewArea(viewer);
  unbind();
  assert.deepEqual(picks, [[800, 450]]);
  assert.ok(Math.abs(area.lon - 3.5) < 1e-9);
  assert.ok(Math.abs(area.lat - 51.25) < 1e-9);
  assert.ok(Math.abs(area.radiusKm - 120) < 1e-9);
});

test('sky in the middle, a failed pick or no canvas leave the camera position', () => {
  for (const options of [
    { hit: null },
    { hit: new Error('no globe') },
    { hit: fromDegrees(0, 0), size: [0, 0] },
  ]) {
    const { viewer, unbind } = viewerWith({ height: 5000, ...options });
    const area = vesselViewArea(viewer);
    unbind();
    assert.deepEqual(area, { lat: 52, lon: 4, radiusKm: 10 });
  }
});

test('a wide view, an unknown height or no camera asks for every vessel', () => {
  for (const height of [500000, NaN]) {
    const { viewer, unbind } = viewerWith({ height });
    const area = vesselViewArea(viewer);
    unbind();
    assert.equal(area, null);
  }
  assert.equal(vesselViewArea(null), null);
  assert.equal(vesselViewArea({ scene: {} }), null);
});

test('a camera with no position asks for every vessel', () => {
  const { viewer, unbind } = viewerWith({
    height: 5000,
    lon: NaN,
    lat: NaN,
    size: [0, 0],
  });
  const area = vesselViewArea(viewer);
  unbind();
  assert.equal(area, null);
});
