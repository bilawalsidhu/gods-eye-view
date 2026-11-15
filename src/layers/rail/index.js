import { createHistoryBudget } from '../../data/contactPlayback.js';
import { createRailSource } from './source.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createFollow } from './follow.js';
import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createRailCockpitSubject } from './cockpitSubject.js';
import { createRouteDisplay } from './routeDisplay.js';
import { createRailSchedules } from './schedules.js';
import { getRegisteredRailFeed } from '../../data/railFeeds.js';
import { DEFAULT_RAIL_CATEGORY_VISIBILITY, RAIL_POLL_MS } from './policy.js';

/** One Rail layer's mutable scene state; nothing is module-global. */
function createState({ services }) {
  const { setOverlayEntries, setOverlaySourceVisible, clearOverlaySource } =
    services.overlays;
  return {
    _overlayHost: Object.freeze({
      setEntries: setOverlayEntries,
      setVisible: setOverlaySourceVisible,
      clearSource: clearOverlaySource,
    }),
    _historyBudget: createHistoryBudget(),
    _viewer: null,
    _markers: null,
    _enabled: false,
    _generation: 0,
    _cameraChangedAttached: false,
    _cameraDebounceTimer: null,
    _altitudeGateOpen: false,
    _preRenderRemove: null,
    _renderHeld: false,
    _clickHandler: null,
    /** Trains mid-glide; the frame pass walks only these. @type {Set<object>} */
    _moving: new Set(),
    /** feedId → registry entry currently polled. */
    _activeFeeds: new Map(),
    _feedStatus: new Map(),
    _inFlight: new Map(),
    /** train key → runtime entry. */
    _trains: new Map(),
    /**
     * feedId → path pack slot `{status, pack, retryAt, failures}`. Kept
     * across disable/enable, and released with the feed's network and
     * schedule pack once the feed is out of use FEED_RELEASE_AFTER_MS
     * (routeDisplay.js releaseIdleFeeds).
     */
    _pathPacks: new Map(),
    /**
     * The server's feed catalog (GET /api/rail/feeds), which lists a feed
     * that reads its routes from a schedule pack only once that pack is
     * built; null until it loads. Until then only the bundled feeds that
     * need no pack are used, and a catalog that fails is asked for again
     * (viewport.js).
     */
    _catalog: null,
    /** The catalog request in flight: `{controller}`. */
    _catalogRequest: null,
    /** Failed catalog requests in a row, and the timer of the next try. */
    _catalogFailures: 0,
    _catalogRetryTimer: null,
    /** feedId → faint route network built from that feed's path pack. */
    _networks: new Map(),
    /** Network opacity from camera altitude, 0..1. */
    _networkFade: 0,
    /** The selected train's line, split where the train is. */
    _route: null,
    /** The selected trip's stops and headsign from the stops provider. */
    _trip: null,
    _stopsSignature: '',
    _stopLabelsSignature: '',
    /**
     * Stop → `{lat, lon, h, q, position}` for the selected trip, kept per
     * selection; one on a fallback height (q 0-1) is read again each refresh.
     */
    _stopAnchors: new Map(),
    _categories: { ...DEFAULT_RAIL_CATEGORY_VISIBILITY },
    _selectedKey: null,
    /** When the user last selected a train, even the selected one (ms). */
    _selectedAtMs: null,
    _selectedCardAt: 0,
    _selectedCardText: null,
    /** The camera's follow of the selected train (follow.js), or null. */
    _follow: null,
    /** A feed polled only for the selected train (viewport.js), or null. */
    _heldFeedId: null,
    /**
     * The train a first-person view holds (cockpitSubject.js), or null: its
     * marker, 3D model and card are hidden and the selection stays on it.
     */
    _cockpitSubjectKey: null,
    /**
     * The feed of a held train the feed dropped (ingestion.js), polled until
     * the view takes a train again or lets go (cockpitSubject.js), or null.
     */
    _cockpitLostFeedId: null,
    _revision: 0,
    _controlsListener: null,
    _dataManager: null,
    _lastUpdate: null,
    _error: null,
    /** Whether the train cap (MAX_TRAINS_TOTAL) was reported once. */
    _capWarned: false,
  };
}

/**
 * Construct one Rail layer with its own scene state and supplied services.
 *
 * Trains come from the `/api/rail` proxy (src/sources/railService.js), already
 * filtered to trains and tagged with a category. Every train drawn is where
 * its operator last reported it (GPS or station reports); none is placed or
 * moved from a timetable. Motion between reports is the Transit layer's
 * delayed playback, so a train glides at 1x behind real time along its line
 * instead of jumping between reports.
 *
 * Each layer owns a schedule tier (schedules.js): feeds' optional schedule
 * packs and trip updates, read through the same source for the selected
 * train's stops, headsign and delays. It is the default stops provider:
 *
 *   stops.stopsFor({feedId, tripId, routeId, record}, nowMs)
 *     → {stops: RailTripStop[], headsign?: string} | null
 *   stops.onSelect?(train | null)
 *
 * `stopsFor` is called about once a second while a train is selected,
 * synchronously; it returns null while it has nothing (yet) and loads what it
 * needs on its own. RailTripStop is described in stopLabels.js. Pass
 * `stops: null` to draw the selected line without stops.
 *
 * A selected train takes the camera through the optional `services.camera`
 * (follow.js): a moving train is followed, any other flown to once.
 *
 * @param {{services: object, source?: object,
 *   stops?: {stopsFor: Function, onSelect?: Function}|null}} options
 * @returns {object} The data-layer module the manager registers.
 */
export function createRailLayer({
  services,
  source = createRailSource(),
  stops,
}) {
  if (
    !services?.overlays ||
    !services?.render ||
    !services?.sprites ||
    !services?.ground
  ) {
    throw new TypeError(
      'A rail layer needs overlay, render, sprite and ground services',
    );
  }
  if (typeof source?.requestSnapshot !== 'function')
    throw new TypeError('A rail source needs a snapshot operation');
  if (
    stops !== undefined &&
    stops !== null &&
    typeof stops?.stopsFor !== 'function'
  )
    throw new TypeError('A rail stops provider needs a stopsFor operation');
  const state = createState({ services });
  const parts = {};
  const timetable = createRailSchedules({
    source,
    // The server's catalog says which feeds it can read trip updates for.
    hasTripUpdates: (feedId) => {
      const listed = state._catalog?.find((feed) => feed.id === feedId);
      if (listed) return listed.tripUpdates === true;
      return typeof getRegisteredRailFeed(feedId)?.tripUpdatesUrl === 'string';
    },
    pathPackFor: (feedId) => state._pathPacks.get(feedId)?.pack || null,
  });
  const context = {
    state,
    services,
    parts,
    source,
    timetable,
    stops: stops === undefined ? timetable : stops,
  };
  parts.rendering = createRendering(context);
  parts.routes = createRouteDisplay(context);
  parts.selection = createSelection(context);
  parts.follow = createFollow(context);
  parts.controls = createControls(context);
  parts.ingestion = createIngestion(context);
  parts.viewport = createViewport(context);
  parts.lifecycle = createLifecycle(context);
  parts.cockpit = createRailCockpitSubject(context);

  return Object.assign(
    { updateInterval: RAIL_POLL_MS },
    parts.lifecycle.methods,
    parts.controls.methods,
    parts.cockpit.methods,
    {
      /** Test seams: this instance's own state and parts. */
      _railStateForTest: () => state,
      _railPartsForTest: () => parts,
    },
  );
}

export {
  RAIL_CATEGORY_COLORS,
  RAIL_POLL_MS,
  buildRailSelectionCopy,
  railTrainKey,
} from './policy.js';
