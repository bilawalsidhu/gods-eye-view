import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceServices } from '../surfaceServices.js';
import { createApplicationTransit } from './transit.js';
import { createApplicationCatalog } from '../constructCatalog.js';
import { createStandaloneLayerSources } from '../../standalone/layerSources.js';

/** A terrain source that answers every point with one ellipsoidal height. */
function fixtureSurface(signal, demM) {
  return createSurfaceServices({
    terrainSource: {
      getHeights: async (chunk) => chunk.map(() => ({ ellipsoid: demM })),
    },
    signal,
    eventTarget: null,
  });
}

test('transit reads the mesh floor the application resolved, through the application surface', async (t) => {
  // The floor transit draws on is the ONE the application constructs — the
  // instance aircraft and camera geometry stand on — not a module-level copy.
  // An earlier cut imported the legacy singleton and could not see a mesh
  // floor the app had already resolved for a cell; it drew on bare earth.
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const surface = fixtureSurface(lifetime.signal, 20);
  const layer = createApplicationTransit({ surface });
  const height = layer._transitPartsForTest().height;
  const lat = 42.3601;
  const lon = -71.0589;

  // Nothing warm yet: the layer has no floor and no prior to borrow.
  assert.equal(height.requestHeight(lat, lon).height, null);

  // The application resolves the DEM for that cell...
  await surface.groundFloor.resolveGroundFloorCells([{ lat, lon }]);
  const lift = surface.groundFloor.GROUND_FLOOR_LIFT_M;
  assert.equal(
    height.requestHeight(lat, lon).height,
    20 + lift,
    'the DEM floor, lifted',
  );

  // ...and then a rendered-mesh sample lands on the same cell, seventeen
  // metres above bare earth, the way a photogrammetric street sits.
  assert.equal(
    surface.groundFloor.reportValidatedMeshFloorCell(lat, lon, 37),
    true,
  );
  assert.equal(
    surface.groundFloor.cachedGroundFloor(lat, lon),
    37,
    'the app now floors on the mesh',
  );
  assert.equal(
    height.requestHeight(lat, lon).height,
    37 + lift,
    'and so does transit — the same number',
  );

  // Leaving the photoreal regime drops back to the DEM for everyone at once.
  surface.groundFloor.setMeshFloorPreferred(false);
  assert.equal(height.requestHeight(lat, lon).height, 20 + lift);
});

test('the catalog hands transit the same surface it hands everything else', async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const surface = fixtureSurface(lifetime.signal, 5);
  const catalog = createApplicationCatalog({
    sources: createStandaloneLayerSources(),
    signal: lifetime.signal,
    surface,
  });
  const transit = catalog.get('transit');
  assert.ok(transit, 'transit is in the catalog');
  const lat = 30.2672;
  const lon = -97.7431;
  await surface.groundFloor.resolveGroundFloorCells([{ lat, lon }]);
  surface.groundFloor.reportValidatedMeshFloorCell(lat, lon, 22);
  assert.equal(
    transit._transitPartsForTest().height.requestHeight(lat, lon).height,
    22 + surface.groundFloor.GROUND_FLOOR_LIFT_M,
  );
});

test('transit refuses to build without the application surface', () => {
  assert.throws(() => createApplicationTransit({}), /surface/);
  assert.throws(
    () => createApplicationTransit({ surface: { groundFloor: {} } }),
    /surface/,
  );
});
