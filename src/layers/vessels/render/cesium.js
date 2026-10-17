// The vessels layer's renderer on Cesium (phase 3 Task 13a): the Cesium
// objects the layer used to build itself, moved here one for one — its
// BillboardCollection of ship chevrons (translucent blend, screen-aligned
// rotation, centred, never depth-tested), the camera reads (horizon
// occluder, window projection, canvas size), the "another layer took the
// camera" signal (viewer.trackedEntityChanged) and the selected vessel's
// trail (data/trailRenderer's entity polyline). Nothing here decides
// anything: the layer's logic decides, this draws.
//
// The trail stays an entity polyline (createTrail) rather than engine.lines:
// Cesium's engine.lines is a Primitive with a depth-fail appearance, the
// path that did not draw segments below the photoreal mesh in round 6
// (plan, the T13/T15 blocker; flights keeps the same entity path in 10a).
//
// Interface (shared with render/navara.js): ./contract.js.

import * as Cesium from 'cesium';

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {object|null} engine The Cesium globe engine (null in unit tests).
 * @param {{ viewer: object, createTrail?: Function,
 *   adopt?: { billboardCollection?: object } }} options
 *   `createTrail`: data/trailRenderer's (no trail without it); `adopt`: an
 *   existing collection (test seam).
 * @returns {import('./contract.js').VesselRenderer}
 */
export function createVesselsCesiumRenderer(
  engine,
  { viewer = null, createTrail = null, adopt = {} } = {},
) {
  let collection = adopt.billboardCollection ?? null;

  const view = {
    get camera() {
      return viewer?.camera;
    },
    get scene() {
      return viewer?.scene;
    },
    /** For this pass: the ellipsoid horizon at the camera, or null. */
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
    /** The Cesium collection (data/spriteOrder registers it), or null. */
    get collection() {
      return collection;
    },
    attached: () => Boolean(collection),
    attach({ show }) {
      if (collection || !viewer) return;
      collection = new Cesium.BillboardCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      collection.show = show;
      viewer.scene.primitives.add(collection);
    },
    setVisible(show) {
      if (collection) collection.show = show;
    },
    /**
     * One chevron: the Billboard is the handle (the logic writes position,
     * show, rotation, image, scale and color on it).
     */
    add({ position, show, image, scale, rotation, id }) {
      return collection.add({
        position,
        show,
        image,
        scale,
        rotation,
        alignedAxis: Cesium.Cartesian3.ZERO,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        // Locked height-datum principle #2: contacts are ALWAYS visible —
        // depth-test-free sprites; the EllipsoidalOccluder handles the far
        // side. (The tile sea mesh ≠ the geoid exactly, so a depth-tested
        // chevron at the geoid still clips out behind local tide/mesh noise.)
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id,
      });
    },
    remove(handle) {
      collection?.remove(handle);
    },
    detach() {
      if (collection && viewer?.scene?.primitives)
        viewer.scene.primitives.remove(collection);
      collection = null;
    },
  };

  /** The record a pick is of (Cesium: the billboard id is the record). */
  const pickedRecord = (picked) => {
    const rawId = picked?.id ?? picked?.primitive?.id;
    return rawId && typeof rawId === 'object' && Object.hasOwn(rawId, 'mmsi')
      ? rawId
      : null;
  };

  // Vessels never set viewer.trackedEntity: a new tracked entity belongs to
  // another layer, which takes the scene.
  const follow = {
    onChanged: (listener) =>
      viewer.trackedEntityChanged.addEventListener(listener),
    active: () => Boolean(viewer?.trackedEntity),
  };

  const trails = {
    create: ({ color, width }) =>
      typeof createTrail === 'function' && viewer
        ? createTrail(viewer, { color, width })
        : null,
  };

  return {
    kind: 'cesium',
    engine,
    view,
    fleet,
    pickedRecord,
    follow,
    trails,
    destroy() {},
  };
}
