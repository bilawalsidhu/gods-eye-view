import { createNavaraMaps } from '../maps.js';
import { createNavaraSurface } from '../surface.js';

// A source with deterministic samples, using the maps and surface adapters.
export async function createContractFixtures() {
  let read = () => 0;
  const view = {
    addSource: () => ({ delete() {} }),
    addLayer: () => ({ delete() {}, update() {} }),
    forceUpdate() {},
    sampleTerrainMostDetailed: async (_source, places) =>
      places.map(({ lng, lat }) => ({
        height: read({
          longitude: (lng * Math.PI) / 180,
          latitude: (lat * Math.PI) / 180,
        }),
      })),
  };
  const maps = createNavaraMaps(view, { setInterval: () => null });
  await maps.maps.setTerrain({ kind: 'keyless' });
  const { surface } = createNavaraSurface(
    view,
    { retainTileGeometry() {} },
    maps.sampleTerrain,
  );
  return {
    maps: maps.maps,
    terrain: {
      surface,
      sample: (next) => {
        read = next ?? (() => 0);
      },
    },
    destroy: () => maps.destroy(),
  };
}
