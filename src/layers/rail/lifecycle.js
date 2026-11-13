import * as Cesium from 'cesium';
import { destroyTrack } from '../../data/contactPlayback.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';
import {
  CAMERA_PERCENTAGE_CHANGED,
  RAIL_SELECTED_OVERLAY_SOURCE_ID,
} from './policy.js';
import { RAIL_STOP_OVERLAY_SOURCE_ID } from './stopLabels.js';
import {
  RAIL_ENABLED_FEEDS,
  railFeedNeedsSchedulePack,
} from '../../data/railFeeds.js';

/**
 * Init / enable / disable / update / destroy for one Rail layer instance.
 * Everything acquired here is released here: the primitive collection, the
 * sprite registration, the pick owner, listeners, the render hold and the
 * camera sensitivity this layer borrowed.
 * @param {object} context
 * @returns {object}
 */
export function createLifecycle({ state, services, parts, timetable }) {
  const {
    registerSpriteCollection,
    unregisterSpriteCollection,
    restoreSpriteOrder,
  } = services.sprites;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { releaseContinuousRender } = services.render;

  function dropAllTrains() {
    for (const entry of state._trains.values()) {
      parts.rendering.cancelWake(entry);
      destroyTrack(entry.track);
    }
    state._trains.clear();
    state._moving.clear();
    state._markers?.removeAll();
  }

  const methods = {
    id: 'rail',
    name: 'Rail',
    icon: '🚆',
    source: 'GTFS-RT',

    /** Create the marker collection. Called once at bootstrap. */
    init(viewer) {
      state._viewer = viewer;
      state._markers = new Cesium.BillboardCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(state._markers);
      registerSpriteCollection('rail', state._markers);
      state._markers.show = false;
      state._enabled = false;
      state._overlayHost.setVisible(RAIL_SELECTED_OVERLAY_SOURCE_ID, false);
      state._overlayHost.setVisible(RAIL_STOP_OVERLAY_SOURCE_ID, false);
      restoreSpriteOrder(viewer);
      // A feed that needs its schedule pack runs only once the server's
      // catalog lists it (its pack is built); the catalog's own count is
      // logged when it arrives (viewport.js).
      const packless = RAIL_ENABLED_FEEDS.filter(
        (feed) => !railFeedNeedsSchedulePack(feed),
      ).length;
      console.log(
        `[Data:Rail] Initialized: ${RAIL_ENABLED_FEEDS.length} train feeds registered, ${packless} need no schedule pack`,
      );
    },

    /** Show trains, watch the camera, and poll every feed in range. */
    enable(viewer) {
      state._enabled = true;
      state._generation += 1;
      state._error = null;
      state._markers.show = true;
      state._overlayHost.setVisible(RAIL_SELECTED_OVERLAY_SOURCE_ID, true);
      state._overlayHost.setVisible(RAIL_STOP_OVERLAY_SOURCE_ID, true);
      parts.selection.installClickHandler(viewer);
      registerPickOwner('rail', (pickedId) => state._trains.has(pickedId));
      if (!state._cameraChangedAttached) {
        viewer.camera.changed.addEventListener(parts.viewport.onCameraChanged);
        claimCameraSensitivity(
          viewer.camera,
          'rail',
          CAMERA_PERCENTAGE_CHANGED,
        );
        state._cameraChangedAttached = true;
      }
      if (!state._preRenderRemove)
        state._preRenderRemove = viewer.scene.preRender.addEventListener(
          parts.rendering.onPreRender,
        );
      state._networkFade = -1;
      parts.viewport.loadCatalog();
      parts.viewport.runProximityCheck();
      restoreSpriteOrder(viewer);
    },

    /** Hide everything, stop polling, drop all trains. */
    disable(viewer) {
      state._enabled = false;
      state._generation += 1;
      clearTimeout(state._cameraDebounceTimer);
      state._cameraDebounceTimer = null;
      parts.selection.clearSelection();
      state._overlayHost.setVisible(RAIL_SELECTED_OVERLAY_SOURCE_ID, false);
      state._overlayHost.setVisible(RAIL_STOP_OVERLAY_SOURCE_ID, false);
      parts.selection.removeClickHandler();
      unregisterPickOwner('rail');
      if (state._cameraChangedAttached) {
        viewer.camera.changed.removeEventListener(
          parts.viewport.onCameraChanged,
        );
        releaseCameraSensitivity(viewer.camera, 'rail');
        state._cameraChangedAttached = false;
      }
      state._preRenderRemove?.();
      state._preRenderRemove = null;
      parts.viewport.cancelCatalog();
      timetable.stop();
      parts.ingestion.abortAllInFlight();
      state._activeFeeds.clear();
      state._heldFeedId = null;
      state._feedStatus.clear();
      dropAllTrains();
      // Floor cells and track samples queued for trains now gone.
      parts.rendering.reset();
      parts.routes.hideAll();
      if (state._markers) state._markers.show = false;
      state._altitudeGateOpen = false;
      if (state._renderHeld) {
        releaseContinuousRender('rail');
        state._renderHeld = false;
      }
    },

    /** Manager tick (every RAIL_POLL_MS): sweep, then re-poll active feeds. */
    async update() {
      if (!state._enabled) return;
      parts.ingestion.sweepAgedTrains(Date.now());
      parts.routes.releaseIdleFeeds(Date.now());
      const generation = state._generation;
      await Promise.all(
        [...state._activeFeeds.values()].map((feed) =>
          parts.ingestion.pollFeed(feed, generation),
        ),
      );
    },

    /** Tear down the collection and release every shared registration. */
    destroy(viewer) {
      this.disable(viewer);
      parts.routes.destroy();
      if (state._markers) {
        unregisterSpriteCollection('rail', state._markers);
        viewer?.scene?.primitives?.remove(state._markers);
        state._markers = null;
      }
      state._overlayHost.clearSource(RAIL_SELECTED_OVERLAY_SOURCE_ID);
      state._dataManager = null;
      state._viewer = null;
    },
  };

  return { methods };
}
