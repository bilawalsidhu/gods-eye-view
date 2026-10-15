// Every private Navara member the engine relies on, in one place. Written
// against @navaramap/three 0.2.1 (package.json pins it exactly; the test in
// internals.test.mjs fails if the two drift apart): re-check each access below
// before moving to another Navara version. Each names the parity spike that
// found it and the public API that would replace it upstream.

import { ModelMesh } from '@navaramap/three';

export const NAVARA_INTERNALS_VERSION = '0.2.1';

let restoreRelease = null;

/**
 * S2: keep 3D-tile positions and indices on the CPU after upload so the
 * surface ray can hit them. Private: ModelMesh.prototype._releaseGeometryArrays,
 * which frees every attribute array once the tile is on the GPU. Patched on
 * the prototype, for all views; idempotent. Upstream ask: an option to retain
 * tile geometry for ray queries, or a sampleHeight/pickRay over 3D tiles.
 * Throws when the member is gone (another Navara version).
 */
export function retainTileGeometry() {
  if (restoreRelease) return restoreRelease;
  const proto = ModelMesh.prototype;
  const release = proto._releaseGeometryArrays;
  if (typeof release !== 'function')
    throw new Error('ModelMesh._releaseGeometryArrays not found');
  proto._releaseGeometryArrays = function releaseAllButPositions(mesh) {
    const geometry = mesh.geometry;
    const position = geometry?.attributes?.position;
    const index = geometry?.index ?? null;
    if (!position) return release.call(this, mesh);
    delete geometry.attributes.position;
    geometry.index = null;
    try {
      return release.call(this, mesh);
    } finally {
      geometry.attributes.position = position;
      geometry.index = index;
    }
  };
  restoreRelease = () => {
    proto._releaseGeometryArrays = release;
    restoreRelease = null;
  };
  return restoreRelease;
}

/**
 * S2: the loaded 3D-tile roots (ModelMesh objects). Private: view._scenes.mrt,
 * the scene Navara renders tiles into. Upstream ask: as for
 * retainTileGeometry.
 */
export function tileRoots(view) {
  return (view._scenes?.mrt?.children ?? []).filter(
    (object) => object instanceof ModelMesh,
  );
}

/**
 * S2/S5: whether Navara has stopped updating (tiles loaded, camera still).
 * Private: view._isIdle, which the public `idle` event reports only as an
 * edge. Upstream ask: a public isIdle/tilesLoaded getter.
 */
export function isIdle(view) {
  return view._isIdle === true;
}

/** The hooks createNavaraEngine takes. */
export const navaraHooks = (view) => ({
  retainTileGeometry,
  tileRoots: () => tileRoots(view),
  isIdle: () => isIdle(view),
});
