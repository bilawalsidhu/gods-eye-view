import * as geo from '../../../geo/index.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../../data/cameraSensitivity.js';
import { CAMERA_PERCENTAGE_CHANGED } from '../policy.js';
import { createTransitSpriteBanks } from './navaraSprites.js';
import { createTransitNavaraView } from './navaraView.js';
import { createTransitNavaraTrail } from './navaraTrail.js';

/** Navara resources only; ingestion, playback and selection stay shared. */
export function createTransitNavaraRenderer(
  engine,
  { state, services, drawAtlas, ...native } = {},
) {
  let destroyed = false,
    attached = false,
    sprites = null;
  const removers = new Set(),
    credits = new Map(),
    trails = new Set();
  const view = createTransitNavaraView(engine);
  const own = (remove) => {
    const release = () => {
      if (removers.delete(release)) remove();
    };
    removers.add(release);
    return release;
  };
  return {
    attach() {
      attached = true;
    },
    get ready() {
      return attached && !destroyed;
    },
    createMarkers() {
      sprites = createTransitSpriteBanks(engine, { drawAtlas });
      return sprites.collections;
    },
    whenReady: () => sprites?.ready,
    restoreOrder() {},
    cameraCartographic: view.cameraCartographic,
    cameraSignature: view.cameraSignature,
    rotation: view.rotation,
    visibilityTester: view.visibilityTester,
    viewRectangle: () => engine.camera.viewRectangle(),
    claimCamera: () =>
      claimCameraSensitivity(
        engine.camera,
        'transit',
        CAMERA_PERCENTAGE_CHANGED,
      ),
    releaseCamera: () => releaseCameraSensitivity(engine.camera, 'transit'),
    onCameraChanged: (fn) => own(engine.camera.changed.addEventListener(fn)),
    onPreRender: (fn) =>
      own(
        engine.frames.preRender.addEventListener((...args) => {
          view.refresh();
          sprites.inFrame(() => fn(...args));
        }),
      ),
    onPostRender: (fn) => own(engine.frames.postRender.addEventListener(fn)),
    terrainHeight(lat, lon) {
      // Mesh sampling keeps the application's existing budgets and cache.
      if (engine.maps.current().photoreal) return undefined;
      return engine.surface.terrainHeight(
        geo.cartographic.fromDegrees(lon, lat),
      );
    },
    sampleMeshFloorCells: (points, options) =>
      services.mesh?.sampleMeshFloorCells?.(engine, points, options),
    addCredit(feed) {
      if (credits.has(feed.id)) return;
      credits.set(
        feed.id,
        engine.credits.addStatic(services.credits.transitFeedCredit(feed).html),
      );
    },
    createTrailRenderer() {
      const trail = createTransitNavaraTrail(engine, native);
      trails.add(trail);
      const destroy = trail.destroy;
      trail.destroy = () => {
        trails.delete(trail);
        destroy();
      };
      return trail;
    },
    bindClick(listener, pointerFree) {
      const remove = own(
        engine.input.on('click', (event) => {
          if (!pointerFree()) return;
          const picked = engine.picker.pick(event.position);
          const id = typeof picked?.id === 'string' ? picked.id : null;
          const entry = state._vehicles.get(id);
          listener({
            id,
            primitiveId: null,
            x: event.position.x,
            y: event.position.y,
            collection: entry
              ? entry.markerCollection === state._animatedMarkers
                ? 'animated'
                : 'stationary'
              : null,
          });
        }),
      );
      return { destroy: remove };
    },
    frameProbe() {
      // Public engine API has no per-layer GPU upload hook. Count all scene
      // uploads as an explicit upper bound, never misreport unavailable as zero.
      return {
        canvas: engine.host.canvas,
        gl: engine.host.canvas.getContext('webgl2'),
        uploads: [],
        allUploads: true,
        uploadScope: 'scene-upper-bound',
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of [...removers]) remove();
      this.releaseCamera();
      for (const trail of [...trails]) trail.destroy();
      sprites?.destroy();
      for (const remove of credits.values()) remove();
      credits.clear();
      attached = false;
    },
  };
}
