// A vessel renderer (src/layers/vessels/render/contract.js) over a stub
// viewer and the test's own billboard collection, for testing the vessel
// layer's logic against Cesium-shaped fakes: chevrons are what the
// collection's add returns (the record is their id), the camera reads are
// the viewer's (Cesium's horizon occluder and window projection, which tests
// may stub), "another layer took the camera" is viewer.trackedEntityChanged
// and trails come from `createTrail` (none without it). Not the application's
// display (render/display.js): that one is tested in display.test.mjs.

import * as Cesium from 'cesium';

/**
 * @param {{ viewer: object, billboardCollection?: object,
 *   createTrail?: (viewer: object, options: object) => object }} options
 */
export function vesselViewerRenderer({
  viewer,
  billboardCollection = null,
  createTrail = null,
}) {
  let collection = billboardCollection;

  const view = {
    get camera() {
      return viewer?.camera;
    },
    get scene() {
      return viewer?.scene;
    },
    horizon() {
      const cameraPosition = viewer?.camera?.positionWC;
      if (!cameraPosition) return null;
      return new Cesium.EllipsoidalOccluder(
        Cesium.Ellipsoid.WGS84,
        cameraPosition,
      );
    },
    worldToWindow: (position, result) =>
      Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        position,
        result,
      ),
    canvasSize() {
      const canvas = viewer?.scene?.canvas || viewer?.canvas;
      return {
        width: Number(canvas?.clientWidth) || 0,
        height: Number(canvas?.clientHeight) || 0,
      };
    },
    requestRender: () => viewer?.scene?.requestRender?.(),
    on(event, listener) {
      const source =
        event === 'preRender'
          ? viewer?.scene?.preRender
          : event === 'moveEnd'
            ? viewer?.camera?.moveEnd
            : null;
      return typeof source?.addEventListener === 'function'
        ? source.addEventListener(listener)
        : null;
    },
  };

  const fleet = {
    attached: () => Boolean(collection),
    attach({ show }) {
      if (collection || !viewer) return;
      collection = new Cesium.BillboardCollection();
      collection.show = show;
      viewer.scene.primitives.add(collection);
    },
    setVisible(show) {
      if (collection) collection.show = show;
    },
    add: ({ position, show, image, scale, rotation, id }) =>
      collection.add({ position, show, image, scale, rotation, id }),
    remove(handle) {
      collection?.remove(handle);
    },
    detach() {
      if (collection && viewer?.scene?.primitives)
        viewer.scene.primitives.remove(collection);
      collection = null;
    },
  };

  return {
    engine: null,
    view,
    fleet,
    // The billboard id is the record.
    pickedRecord(picked) {
      const rawId = picked?.id ?? picked?.primitive?.id;
      return rawId && typeof rawId === 'object' && Object.hasOwn(rawId, 'mmsi')
        ? rawId
        : null;
    },
    follow: {
      onChanged: (listener) =>
        viewer.trackedEntityChanged.addEventListener(listener),
      active: () => Boolean(viewer?.trackedEntity),
    },
    trails: {
      create: ({ color, width }) =>
        typeof createTrail === 'function' && viewer
          ? createTrail(viewer, { color, width })
          : null,
    },
    destroy() {},
  };
}
