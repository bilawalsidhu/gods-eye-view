import * as Cesium from 'cesium';
import { createHistoryBudget } from '../../data/contactPlayback.js';

/**
 * One Transit layer's mutable scene state. Every field lives on the instance,
 * so two layers built from this factory never share a viewer, a primitive
 * collection, a request map or a height cache.
 * @param {{services: object}} context
 * @returns {object}
 */
export function createState({ services }) {
  const { setOverlayEntries, setOverlaySourceVisible, clearOverlaySource } =
    services.overlays;

  const state = {};
  state._historyBudget = createHistoryBudget();

  state.DEFAULT_OVERLAY_HOST = Object.freeze({
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  });
  state._overlayHost = state.DEFAULT_OVERLAY_HOST;

  /** @type {Cesium.Viewer|null} */
  state._viewer = null;
  /** @type {Cesium.BillboardCollection|null} */
  state._markers = null;
  state._animatedMarkers = null;
  state._visible = new Set();
  state._visibilityTimer = null;
  state._maintenanceTimer = null;
  state._detectBuiltAt = -Infinity;
  state._cameraRevision = 0;
  state._rotationRevision = -1;
  state._enabled = false;
  state._generation = 0;

  state._cameraChangedAttached = false;
  state._cameraDebounceTimer = null;
  state._altitudeGateOpen = false;
  /** Camera sensitivity as we found it, so disable() can hand it back. */
  state._priorPercentageChanged = null;
  /** The value this layer actually wrote, for an identity-guarded restore. */
  state._appliedPercentageChanged = null;

  /** @type {(() => void)|null} */
  state._preRenderRemove = null;
  state._renderHeld = false;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  state._clickHandler = null;
  /**
   * The vehicles currently mid-glide. The per-frame pass walks THIS, not the
   * whole fleet, and the render hold is derived from it together with the
   * height queue — so both track work that exists rather than a window of time
   * the layer hoped would contain some.
   * @type {Set<object>}
   */
  state._moving = new Set();
  /** Vehicles whose sampled height landed after they were drawn. @type {Set<object>} */
  state._heightDirty = new Set();
  /**
   * Inflated camera view bounds in degrees, or null before the first camera
   * read. Decides which vehicles are worth animating frame by frame.
   * @type {{south:number,north:number,west:number,east:number}|null}
   */
  state._viewBounds = null;
  /** How many vehicles are currently drawn, as opposed to held. */
  state._shownCount = 0;
  /** Deferred shown/hidden sweep bookkeeping. */
  state._visibilityDirty = true;
  state._visibilityAt = 0;
  /** Throttle bookkeeping for the screen-space rotation pass. */
  state._rotationAt = 0;
  state._rotationPose = null;
  state._rotationDirty = false;

  /** @type {Map<string, object>} feedId → registry entry currently polled */
  state._activeFeeds = new Map();
  /** @type {Map<string, {count:number, lastUpdate:number|null, error:string|null, stale:boolean, pollSeq:number, loading:boolean}>} */
  state._feedStatus = new Map();
  /** @type {Map<string, {controller: AbortController, promise: Promise<void>}>} */
  state._inFlight = new Map();
  /** @type {Map<string, object>} vehicle key → runtime entry */
  state._vehicles = new Map();

  /** Timer for the floor re-read cycle, and how many it has spent. */
  state._floorTimer = null;
  state._floorAttempts = 0;
  /** Where the next warm window starts among the cold cells: no cell waits for ever. */
  state._floorCursor = 0;

  /** @type {string|null} */
  state._selectedKey = null;
  state._selectedCardAt = 0;
  /** The card text last published, so an unchanged card is not re-sent. */
  state._selectedCardText = null;
  /**
   * Bumped whenever the set of vehicles DETECT may see could have changed —
   * a poll, a visibility sweep, a removal, a selection — so the candidate
   * list is rebuilt on change rather than on every paint.
   */
  state._detectRevision = 0;
  /** The candidate list DETECT was last handed, and the revision it was built at. */
  state._detectCache = null;
  /**
   * Active post-FX style the sprites are drawn for. Read from the document
   * at init and followed through the style and cockpit-vision events; a
   * cockpit override wins over the map style while it lasts.
   */
  state._stylePreset = 'normal';
  state._cockpitVision = false;
  /** @type {Array<[string, EventListener]>} window listeners to remove on destroy. */
  state._styleListeners = [];
  /** @type {{ refreshLayerStats?: () => void }|null} */
  state._dataManager = null;
  /** @type {number|null} */
  state._lastUpdate = null;
  /** @type {string|null} */
  state._error = null;
  state._limitWarned = false;

  state._scratchCartesian = new Cesium.Cartesian3();

  return state;
}
