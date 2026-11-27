import { destroyTrack } from '../../data/contactPlayback.js';
import { RAIL_SELECTED_OVERLAY_SOURCE_ID } from './policy.js';
import { RAIL_STOP_OVERLAY_SOURCE_ID } from './stopLabels.js';
import {
  RAIL_ENABLED_FEEDS,
  railFeedNeedsSchedulePack,
} from '../../data/railFeeds.js';

/**
 * Init / enable / disable / update / destroy for one Rail layer instance.
 * Everything acquired here is released here: the icon set, the pick owner,
 * listeners (the camera's at this layer's own threshold), and the render
 * hold.
 * @param {object} context
 * @returns {object}
 */
export function createLifecycle({ state, services, parts, timetable }) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { releaseContinuousRender } = services.render;

  function dropAllTrains() {
    for (const entry of state._trains.values()) {
      parts.rendering.cancelWake(entry);
      destroyTrack(entry.track);
      entry.placement?.forget(entry.key);
    }
    state._trains.clear();
    state._moving.clear();
    parts.rendering.clearMarkers();
  }

  const methods = {
    id: 'rail',
    name: 'Rail',
    icon: '🚆',
    source: 'GTFS-RT',

    /** Create the train icon set. Called once at bootstrap. */
    init(viewer, { panel = null } = {}) {
      state._viewer = viewer;
      state._panel = panel;
      parts.rendering.createMarkers(viewer);
      state._enabled = false;
      state._overlayHost.setVisible(RAIL_SELECTED_OVERLAY_SOURCE_ID, false);
      state._overlayHost.setVisible(RAIL_STOP_OVERLAY_SOURCE_ID, false);
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
      parts.rendering.showMarkers(true);
      state._overlayHost.setVisible(RAIL_SELECTED_OVERLAY_SOURCE_ID, true);
      state._overlayHost.setVisible(RAIL_STOP_OVERLAY_SOURCE_ID, true);
      parts.selection.installClickHandler(viewer);
      registerPickOwner('rail', (pickedId) => state._trains.has(pickedId));
      if (!state._cameraChangedAttached) {
        parts.viewport.watchCamera(viewer);
        // Attached only with a camera to listen to, so a later enable retries.
        state._cameraChangedAttached = state._cameraChangedOff !== null;
      }
      parts.rendering.startFrames(viewer);
      state._networkFade = -1;
      parts.rendering.startModels();
      parts.viewport.loadCatalog();
      parts.viewport.runProximityCheck();
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
      // Unconditional: whatever watching started, none of it outlives this.
      parts.viewport.unwatchCamera();
      state._cameraChangedAttached = false;
      parts.rendering.stopFrames();
      parts.viewport.cancelCatalog();
      timetable.stop();
      parts.ingestion.abortAllInFlight();
      state._activeFeeds.clear();
      state._heldFeedId = null;
      state._cockpitSubjectKey = null;
      state._cockpitLostFeedId = null;
      state._feedStatus.clear();
      dropAllTrains();
      parts.rendering.stopModels();
      // Floor cells and track samples queued for trains now gone.
      parts.rendering.reset();
      parts.routes.hideAll();
      parts.rendering.showMarkers(false);
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

    /** Tear down the icon set and release every shared registration. */
    destroy(viewer) {
      this.disable(viewer);
      parts.rendering.stopModels(true);
      parts.routes.destroy();
      parts.rendering.destroyMarkers();
      state._overlayHost.clearSource(RAIL_SELECTED_OVERLAY_SOURCE_ID);
      state._panel = null;
      state._viewer = null;
    },
  };

  return { methods };
}
