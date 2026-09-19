import * as Cesium from 'cesium';
import { FLOW_BUCKET_COLORS, TRAFFIC_TIMING_ENABLED } from './policy.js';

export function createState({ services }) {
  const layerState = {};

  // ─── Module State ──────────────────────────────────────────
  /** @type {Cesium.Viewer|null} */

  layerState._viewer = null;

  /** @type {Cesium.PointPrimitiveCollection|null} */

  layerState._pointCollection = null;

  /** @type {Array<{point:Cesium.PointPrimitive, waypoints:Cesium.Cartesian3[], segmentDist:number[], numSegments:number, segIdx:number, t:number, mps:number, direction:number, stoppedUntil:number}>} Active animated dots */

  layerState._dots = [];

  /** @type {Array<{coords:number[][], type:string, waypoints:Cesium.Cartesian3[], segmentDist:number[]}>} Parsed roads with pre-computed Cartesian3 waypoints */

  layerState._roads = [];

  /** @type {boolean} Whether the layer is currently enabled */

  layerState._enabled = false;

  /** @type {Function|null} Disposer returned by preRender event subscription */

  layerState._preRenderRemover = null;

  /** @type {Function|null} Disposer returned by camera.changed event subscription */

  layerState._cameraRemover = null;
  layerState._arrivalRemover = null;

  /** @type {ReturnType<typeof setTimeout>|null} Debounce timer for camera-change fetch */

  layerState._fetchTimeout = null;

  /** @type {{south:number,west:number,north:number,east:number}|null} Last fetched clamped bounds */

  layerState._lastBounds = null;

  /** @type {boolean} True while an Overpass fetch is in flight */

  layerState._fetching = false;

  /** @type {number} Current count of rendered dots */

  layerState._count = 0;

  /** @type {number|null} Timestamp of last successful render */

  layerState._lastUpdate = null;

  /** @type {number} Monotonic generation counter — incremented on each load to discard stale responses */

  layerState._loadGeneration = 0;

  /** @type {AbortController|null} Controller for the in-flight fetch, so it can be cancelled */

  layerState._activeFetchAbort = null;

  /** @type {number} User-adjustable density multiplier (clamped 0.2–2.5) */

  layerState._densityScale = 1.0;

  /** @type {number} User-adjustable speed multiplier (clamped 0.3–3.0) */

  layerState._speedScale = 1.0;

  /** @type {{lat:number,lon:number}|null} Center of last-fetched viewport for shift gating */

  layerState._lastViewCenter = null;

  /** @type {number|null} camera.percentageChanged value before we overrode it, restored on disable */

  layerState._prevPercentageChanged = null;

  /** @type {boolean} Live TomTom flow mode — true iff /api/tomtom/status reports a key */

  layerState._liveMode = false;

  /**
   * Short user-facing reason live flow is currently unavailable, or null while
   * healthy. Only ever set in live mode: keyless simulation is a designed
   * fallback, not a fault, and must never read as an error.
   * @type {string|null}
   */

  layerState._flowError = null;

  /**
   * True when `/api/tomtom/status` itself could not be reached, so the layer is
   * simulating because it could not ask — not because the server said "no key".
   * @type {boolean}
   */

  layerState._flowStatusUnavailable = false;

  /**
   * True once `/api/tomtom/status` has answered (or failed) at least once.
   * Until then the layer has NOT asked whether a key exists, so getStats()
   * presents the pre-probe simulation as today's FALLBACK rather than
   * claiming "TOMTOM_API_KEY not set" about a deployment it never queried.
   * @type {boolean}
   */

  layerState._flowStatusResolved = false;

  /** @type {number} Epoch ms of the last settled status probe (retry / refresh pacing). */

  layerState._flowStatusAt = 0;

  /** @type {boolean} A background status refresh is in flight (live mode only). */

  layerState._flowStatusRefreshing = false;

  /**
   * Structured provider status the proxy attached to the last status answer
   * (src/sources/live/contract.js providerStatusFromResponse shape), or null
   * for a legacy proxy.
   * @type {{status:string, source:string|null, fetchedAtMs:number|null, ageSec:number|null, error:string|null}|null}
   */

  layerState._flowProvider = null;

  /**
   * Live-speed sample the proxy probed at the scene point (TomTom Flow
   * Segment Data): `{ ok, currentSpeed, freeFlowSpeed, confidence, fetchedAt }`
   * or `{ ok:false, error }`; null keyless or before the first probe.
   * @type {object|null}
   */

  layerState._flowSegment = null;

  /**
   * Reason the status probe reported the keyed feed as degraded (a rejected
   * key, a rate limit, an upstream timeout) BEFORE any tile was fetched. A
   * successful tile fetch clears it; a failed one is reported via
   * `_flowError` instead.
   * @type {string|null}
   */

  layerState._flowProbeError = null;

  /**
   * Daily budget counters from the last status answer — tiles and non-tile
   * requests — for the diagnostics surfaces.
   * @type {{date:string|null, tiles:{count:number,budget:number}, requests:{count:number,budget:number}}|null}
   */

  layerState._flowBudget = null;

  /**
   * Flow requests this layer still owns. The 250 ms paint race lets a flow
   * fetch outlive the road load that started it (cached roads settle
   * instantly), so `_fetching` alone under-reports the work in flight: the
   * loading batch would close with LOAD COMPLETE and a failure landing after
   * it could never be announced. Counted, not boolean — recolor-after-timeout
   * means two loads can overlap.
   * @type {number}
   */

  layerState._flowPending = 0;

  /**
   * Rendered-dot counts per flow bucket (sim = white ambient, no flow data).
   * Reset with the dots in clearDots; drives the data-panel diagnostics and
   * the qa-traffic harness color assertions.
   * @type {{free:number, slow:number, jam:number, sim:number}}
   */

  layerState._bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };

  /** @type {number} Roads in the current render skipped entirely as closed. */

  layerState._closedRoads = 0;

  /** @type {'sim'|'hide'} Live-mode treatment of roads without flow data. */

  layerState._uncoveredMode = 'sim';

  /**
   * Jam-viz prototype mode: 'density' = deep-jam density boost + platoon queues
   * + stop-and-go creep; 'heatline' = congestion corridor polylines; 'both';
   * 'none' = shipped main behavior. Live mode only — the keyless simulation
   * never has `road.flow`, so every jamViz path is unreachable there.
   * Default 'density' — owner A/B verdict 2026-07-23 (heatline stays available
   * via setParams).
   * @type {'none'|'density'|'heatline'|'both'}
   */

  layerState._jamViz = 'density';

  /**
   * Congestion heat-lines are GroundPolylinePrimitive batches draped onto the
   * rendered 3D tiles (ClassificationType.CESIUM_3D_TILE) — polylines at the
   * dots' single-sample heights depth-fail under the mesh across an oblique
   * city view (first A/B capture: 198 lines rendered, zero visible). One
   * primitive per bucket so the jam batch can pulse via a single shared
   * material uniform.
   * @type {Cesium.GroundPolylinePrimitive|null}
   */

  layerState._heatJamPrim = null;

  /** @type {Cesium.GroundPolylinePrimitive|null} Slow-bucket heat-line batch. */

  layerState._heatSlowPrim = null;

  /** @type {number} Heat-lines in the current render (stats). */

  layerState._heatLineCount = 0;

  /** @type {boolean|null} GroundPolylinePrimitive.isSupported, checked once. */

  layerState._heatSupported = null;

  /** @type {number} Altitude of the last render, for late-flow heat rebuilds. */

  layerState._lastRenderAltitude = 0;

  /**
   * Active post-FX style (StyleManager preset name), synced from
   * `document.documentElement.dataset.gevStyle` at init and the
   * `gev:style-change` window event thereafter. Drives the preset-aware dot
   * styling (`trafficPresetStyle.js`): NVG/FLIR/noir re-encode congestion in
   * luminance + size (their shaders discard hue), retro/CRT gets saturated
   * hues + a size boost to survive pixelation. 'normal' → shipped palette.
   * @type {string}
   */

  layerState._stylePreset = 'normal';

  /** @type {'on'|'off'} Kill switch for preset-aware dot styling (A/B). */

  layerState._presetDots = 'on';

  /** @type {boolean} gev:style-change listener bound (bind once per page). */

  layerState._styleListenerBound = false;

  /**
   * Effective per-bucket dot colors: preset override when one applies, else
   * the shipped FLOW_BUCKET_COLORS. Rebuilt on style/param change only —
   * spawn/recolor/restyle all read from here, no per-dot allocation.
   * @type {{free:Cesium.Color, slow:Cesium.Color, jam:Cesium.Color}}
   */

  layerState._activeBucketColors = { ...FLOW_BUCKET_COLORS };

  /**
   * Dot fade-out distances, recomputed per render from the camera-to-area
   * distance. The original constants (8 km scale / 10 km translucency)
   * assumed a nadir view; at oblique pitch the loaded area legitimately sits
   * 7–12+ km from the CAMERA and every dot faded to invisible (field-test
   * round 1: "the screen itself was empty").
   */

  layerState._fadeScaleFar = 8000;

  layerState._fadeTransFar = 10000;

  /** @type {Promise<void>|null} Session-cached status check (one fetch per session) */

  layerState._flowStatusPromise = null;

  /** @type {ReturnType<typeof setInterval>|null} Enable-time retry until the first load commits. */

  layerState._enableKickTimer = null;
  // Failed destinations retry while parked, with a bounded backoff.
  layerState._retryTimer = null;
  layerState._retryDelayMs = 1500;
  layerState._retryBoundsKey = null;
  layerState._roadError = null;
  /**
   * @type {{status:string,source:string|null,error:string|null}|null}
   * Structured status of the last FAILED road fetch (the proxy's
   * `DEGRADED · Overpass · <reason>` answer), null when roads loaded or the
   * failure carried no status.
   */
  layerState._roadProvider = null;

  /** @type {number} 0–100 int — matched roads / roads with any flow candidates */

  layerState._flowCoveragePct = 0;

  /** @type {Function|null} Development-only camera moveEnd timing disposer. */

  layerState._trafficTimingMoveEndRemover = null;

  /** @type {Set<Function>|null} Development-only one-shot postRender disposers. */

  layerState._trafficTimingPostRenderRemovers = null;

  /** @type {{interactionId:number, timestamp:number}|null} Debug anchor for the pending load. */

  layerState._trafficTimingCurrentAnchor = null;

  /** @type {number} Development-only unique mark/trace sequence. */

  layerState._trafficTimingSequence = 0;

  /** @type {number} Development-only count of correlated trace objects created. */

  layerState._trafficTimingTracesCreated = 0;

  /** @type {number} Development-only count of loads dropped for missing/stale anchors. */

  layerState._trafficTimingDroppedTraces = 0;

  /**
   * Tile cache keyed by "s,w,n,e" string.
   * Each entry stores separately fetched major-only and full road sets
   * so the major pass can be served from cache while a full fetch continues.
   * @type {Map<string, {major: Array|null, full: Array|null}>}
   */

  layerState._tileCache = new Map();

  /** Reusable scratch Cartesian3 to avoid per-frame allocation / GC pressure */

  layerState._scratchLerp = new Cesium.Cartesian3();

  // ─── Animation ─────────────────────────────────────────────

  /** @type {number} Timestamp of the last animation tick (ms) */

  layerState._lastAnimTime = 0;

  /** @type {number} Running frame counter (for diagnostics) */

  layerState._animFrame = 0;

  // Disabled-path contract: these references resolve directly to the original
  // functions. Instrumentation adds no load-path callbacks or per-item checks.

  return layerState;
}
