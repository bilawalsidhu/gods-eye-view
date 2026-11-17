import { eciToGeodetic, gstime, propagate } from 'satellite.js';
import { fromRadians } from '../../geo/ellipsoid.js';
import { headingPitchRollOfAxes } from '../../geo/frames.js';
import { copyInto, distance, vec } from '../../geo/vector.js';
import { canvasOf, drawOf, findCamera } from '../../render/rendererOf.js';
import { stationTrackedOn } from './policy.js';

/**
 * A space station as a 3D model when the camera is close, driven by a
 * description of the station (`StationModelSpec`): the ISS (issModel.js) and
 * Tiangong (tiangongModel.js) are two instances of this one factory. Far out
 * the dot stays: the model and the dot (ambient and tracked) split the
 * distance range, so exactly one of them draws (the model by the display
 * range on its draw item, the dots by the display range the rendering part
 * puts on theirs). The model is one item of a `models` set on the
 * renderer's draw port, asked for on first need and only if the station is
 * shown, and posed every frame from its own SGP4 sample (the dot moves once
 * a second, which at model range would show as a jump).
 *
 * The moving parts (the joint driver, `createArticulation`) write node
 * matrices into this part's node poses, as they would into a model's nodes;
 * those poses are the draw item's `nodes`, which the renderer applies to the
 * model's named glTF nodes.
 *
 * @typedef {object} StationModelSpec
 * @property {string} key Short id ('iss', 'tiangong'): the STATION
 *   description's key and the LIVE section's `station:<key>` subject key.
 * @property {string} label The station's name, for log lines.
 * @property {number} norad The catalog entry the model stands at.
 * @property {string} modelUrl Asset path, resolved with `resolveAsset`.
 * @property {number} scale The file's units to meters.
 * @property {number} minPx The model is never drawn smaller than this.
 * @property {number} maxDistanceM Within this camera distance the model
 *   replaces the dot.
 * @property {number} orbitHideM Within this camera distance the station's
 *   orbit ring is hidden.
 * @property {number} cardClearM How many meters of the station the tracked
 *   card keeps clear of.
 * @property {number} companionRadiusM Objects within this of the station,
 *   orbit against orbit, are docked to it.
 * @property {number} companionCoarseM Only dots within this are checked.
 * @property {number} companionScanMs How often the docked set is rescanned.
 * @property {readonly string[]} localAxes Which flight axis each of the
 *   model's local axes points along (see ISS_MODEL_LOCAL_AXES).
 * @property {(noradId: number, entry: object|undefined) => boolean} isModule
 *   Whether a catalog entry at the station is one of its own modules (the
 *   ISS's Nauka, Tiangong's labs) rather than a visiting vehicle.
 * @property {() => object} createArticulation The joint driver
 *   (`update(nodes, date, position, axes)`, `reset()`, and what the STATION
 *   section calls). `nodes` has a model's `ready` and `getNode(name)`, each
 *   node taking a `matrix`.
 * @property {(() => {pose: () => object|null, touch: () => void,
 *   status: () => object, destroy: () => void})|null} createTelemetry A
 *   telemetry feed for the joints, or null for computed angles only.
 * @property {((input: {key: string|null, centre: {x: number, y: number, z: number},
 *   axes: {x: number[], y: number[], z: number[]},
 *   name: (noradId: number|null) => string|null,
 *   entry: (noradId: number|null) => number|null,
 *   dockedVehicle: number|null}) => object|null)|null} cockpitMount The
 *   Cockpit camera's views on the model, or null when the station has none.
 * @property {boolean} hideInCockpit Hide the model while the Cockpit rides
 *   the station: true where its camera would sit inside the hull, false
 *   where it rides a mount on the model.
 * @property {(() => void)|null} syncOrbit Puts the station's ring back to
 *   its own rules on leaving the close-up; null for the layer's orbit toggle
 *   (a ring that exists only while the station is tracked).
 * @property {number} [unloadAfterMs] How long the model may go undrawn (out
 *   of range, or hidden) before its draw set is released and its GPU memory
 *   with it; asked for again on the next approach. Default one minute.
 * @property {number} [retryAfterMs] How long after a failed load the model
 *   is released and asked for again. Default 30 s.
 */

/** Default `unloadAfterMs`: a minute undrawn releases the model. */
export const STATION_MODEL_UNLOAD_AFTER_MS = 60_000;
/**
 * A model that failed to load is released after this and asked for again
 * on the next frame in range (the renderer retries a load only on an
 * update, and a model that is not ready is not sent).
 */
export const STATION_MODEL_RETRY_AFTER_MS = 30_000;

/**
 * Whether a station model may be drawn: the dot's own rules (layer on, points
 * on, the station loaded and its class shown or the station tracked), and
 * not while the Cockpit hides it.
 * @param {{enabled: boolean, showPoints: boolean, hasStation: boolean,
 *   classVisible: boolean, tracked: boolean, cockpitHidden: boolean}} input
 * @returns {boolean}
 */
export function stationModelShouldShow({
  enabled,
  showPoints,
  hasStation,
  classVisible,
  tracked,
  cockpitHidden,
}) {
  return (
    Boolean(enabled) &&
    Boolean(showPoints) &&
    Boolean(hasStation) &&
    (Boolean(classVisible) || Boolean(tracked)) &&
    !cockpitHidden
  );
}

/**
 * A station's flight axes in the Earth-fixed frame, from one SGP4 state: a
 * station normally flies "+XVV", its modules along the velocity, the truss or
 * labs across the orbit plane, the same side always to the Earth. Returned
 * as the model's local axes: x along-track, y the orbit normal, z zenith
 * (away from the Earth's centre).
 * @param {{x:number,y:number,z:number}} positionEcef Earth-fixed position.
 * @param {{x:number,y:number,z:number}} velocityEcefAxes Inertial velocity,
 *   turned onto the Earth-fixed axes (direction only matters).
 * @returns {{x:number[], y:number[], z:number[]}|null} Unit vectors, or null
 *   for a degenerate state (zero position or velocity along it).
 */
export function stationFlightAxes(positionEcef, velocityEcefAxes) {
  const r = [positionEcef.x, positionEcef.y, positionEcef.z];
  const v = [velocityEcefAxes.x, velocityEcefAxes.y, velocityEcefAxes.z];
  const z = unit(r);
  const y = unit(cross(r, v));
  if (!z || !y) return null;
  const x = cross(y, z);
  return { x, y, z };
}

/**
 * Turn an inertial (TEME) vector onto the Earth-fixed axes at `gmst`: the same
 * rotation `eciToGeodetic` applies to the position.
 * @param {{x:number,y:number,z:number}} v
 * @param {number} gmst Radians.
 * @returns {{x:number,y:number,z:number}}
 */
export function temeToEcefAxes(v, gmst) {
  const c = Math.cos(gmst);
  const s = Math.sin(gmst);
  return { x: c * v.x + s * v.y, y: -s * v.x + c * v.y, z: v.z };
}

/**
 * The model's orientation for the renderer, `{heading, pitch, roll}` at
 * `position`, from the station's flight axes and which of them each model
 * axis points along (`localAxes`).
 * @param {{x:number,y:number,z:number}} position Earth-fixed.
 * @param {{x:number[], y:number[], z:number[]}} axes Flight axes.
 * @param {readonly string[]} localAxes
 * @returns {{heading: number, pitch: number, roll: number}}
 */
export function stationModelOrientation(position, axes, localAxes) {
  const as = (key) => vec(axes[key][0], axes[key][1], axes[key][2]);
  return headingPitchRollOfAxes(position, {
    x: as(localAxes[0]),
    y: as(localAxes[1]),
    z: as(localAxes[2]),
  });
}

/**
 * Node poses as a joint driver writes them: `getNode(name)` hands a node
 * whose `matrix` it sets (a column-major 4×4, copied on write, as a model's
 * node copies), and `poses` keeps every matrix written, by node name: the
 * draw item's `nodes` (`ModelItem.nodes`), one object for the item's life.
 * @returns {{ready: boolean, getNode: (name: string) => {matrix: Float64Array},
 *   poses: Record<string, Float64Array>, clear: () => void}}
 */
export function createNodePoses() {
  /** @type {Record<string, Float64Array>} */
  const poses = {};
  const nodes = new Map();
  return {
    ready: true,
    poses,
    getNode(name) {
      let node = nodes.get(name);
      if (!node) {
        node = {
          get matrix() {
            return poses[name];
          },
          set matrix(value) {
            // None: the node goes back to its authored pose (its name leaves
            // the map), as a model's node does.
            if (value === undefined || value === null) {
              delete poses[name];
              return;
            }
            const kept = (poses[name] ??= new Float64Array(16));
            for (let i = 0; i < 16; i++) kept[i] = value[i];
          },
        };
        nodes.set(name, node);
      }
      return node;
    },
    /** Every node back to its authored pose (its name leaves the map). */
    clear() {
      for (const name of Object.keys(poses)) delete poses[name];
    },
  };
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function unit(a) {
  const n = Math.hypot(a[0], a[1], a[2]);
  if (!(n > 0)) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}

/**
 * One station's model part.
 * @param {StationModelSpec} spec
 * @param {{state: object, parts: object, resolveAsset?: (url: string) => string}} context
 */
export function createStationModel(
  spec,
  { state: layerState, parts, resolveAsset },
) {
  const { norad } = spec;
  /** The `models` draw set the station is an item of, once asked for. */
  let set = null;
  let offReady = null;
  let offFailed = null;
  /** The station's draw item, sent again each frame it is posed. */
  const itemId = `station:${spec.key}`;
  let item = null;
  /** Whether the renderer has the model loaded and posed. */
  let ready = false;
  let loading = false;
  let failed = false;
  /** When the renderer said the load failed (wall-clock ms), or null. */
  let failedAt = null;
  /** Turns the moving parts by where the Sun (and the relays) are. */
  const articulation = spec.createArticulation();
  /** Where the joint driver writes; kept for a renderer that poses nodes. */
  const nodePoses = createNodePoses();
  /**
   * Telemetry for the same joints, where the station has any: asked for only
   * while the model is drawn, and used in place of the computed angles
   * whenever it has a pose.
   */
  const telemetry = spec.createTelemetry?.() ?? null;
  if (telemetry) articulation.setTelemetry?.(() => telemetry.pose());
  /** The eye distances the model draws at. */
  const nearRange = Object.freeze([0, spec.maxDistanceM]);
  /** The eye distances the dots the model stands in for are drawn at. */
  const farRange = Object.freeze([spec.maxDistanceM, Number.MAX_VALUE]);
  /** Whether the station's own dot is left to the model within its range. */
  let dotHanded = false;
  /** Whether the tracked dot is, the tracked satellite being the station. */
  let trackedDotHanded = false;
  /**
   * @type {Set<number>} Objects docked to the station, orbit against orbit,
   * at the last scan: the same body as the model whether or not it draws.
   */
  const dockedByOrbit = new Set();
  /** @type {Set<number>} Docked objects whose dots the model stands in for. */
  const handedCompanions = new Set();
  /** Whether the model draws and the docked dots are left to it. */
  let handingOver = false;
  /** Wall-clock ms since when the model has not been drawn, or null. */
  let undrawnSince = null;
  let lastCompanionScanMs = Number.NEGATIVE_INFINITY;
  /** Whether the station's orbit ring is hidden for the close-up. */
  let orbitHidden = false;
  /** The tracked docked object whose ring is hidden for the close-up, or null. */
  let companionRingHidden = null;
  const scratchPosition = vec();
  const scratchMountCentre = vec();
  /** The station centre the model last rendered at (for the tracked card). */
  const visualPosition = vec();
  let visualValid = false;

  function _shouldShow() {
    const tracked = layerState._trackedNorad === norad;
    return stationModelShouldShow({
      enabled: layerState._enabled,
      showPoints: layerState._params.showPoints,
      hasStation: layerState._catalog.has(norad),
      classVisible: parts.controls._classVisible(norad),
      tracked,
      // With no mounts on the model the Cockpit camera would sit inside the
      // hull, so the model goes while the Cockpit rides the station.
      cockpitHidden:
        spec.hideInCockpit &&
        Boolean(parts.cockpit?._cockpitHeld?.()) &&
        _trackedOnStation(),
    });
  }

  /** The eye, from the camera port, or null without one. */
  function _eye() {
    return findCamera(layerState._viewer)?.pose?.()?.position ?? null;
  }

  /**
   * Ask the renderer for the model: a `models` set of its own with the
   * station as its one item, hidden until posed. On a renderer that draws
   * no models the dot keeps drawing at every distance.
   * @param {{x:number,y:number,z:number}} at Where the station is now.
   */
  function _load(at) {
    const draw = drawOf(layerState._viewer);
    if (typeof draw?.models !== 'function') {
      failed = true;
      return;
    }
    loading = true;
    set = draw.models({ id: `satellites:${itemId}`, show: true });
    offReady = set.on('ready', (id) => {
      if (id !== itemId) return;
      ready = true;
      loading = false;
      failed = false;
    });
    offFailed = set.on('loadFailed', (id, message) => {
      if (id !== itemId) return;
      // The dots keep drawing at every distance (the model is never ready);
      // after `retryAfterMs` the model is released and asked for again.
      failed = true;
      failedAt = Date.now();
      loading = false;
      console.warn(
        `[Data:Satellites] ${spec.label} model failed to load:`,
        message,
      );
    });
    item = {
      id: itemId,
      pos: { x: at.x, y: at.y, z: at.z },
      url: resolveAsset(spec.modelUrl),
      orientation: { heading: 0, pitch: 0, roll: 0 },
      scale: spec.scale,
      minPixelSize: spec.minPx,
      displayRange: nearRange,
      // So a click on the model tracks the station, as a click on its dot does.
      meta: { norad },
      // The joint driver's poses, applied to the model's named nodes.
      nodes: nodePoses.poses,
      show: false,
    };
    set.upsert([item]);
  }

  /** Send the item as it stands. */
  function _send() {
    if (set && item) set.upsert([item]);
  }

  /** Hide the model (nothing sent when it is hidden already). */
  function _hide() {
    if (item && item.show) {
      item.show = false;
      _send();
    }
  }

  /** An object's inertial position at `date`, km, or null. */
  function _temeKm(satrec, date) {
    if (!satrec) return null;
    try {
      const position = propagate(satrec, date)?.position;
      return position && typeof position !== 'boolean' ? position : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the tracked satellite is the station itself: its own entry, or
   * an object docked to it (a module, a cargo ship…), which has a catalog
   * entry and a dot of its own but is the same body as the model. Read from
   * the layer's docked set (dots sharing a position) and from this part's
   * own scan (orbit against orbit), which stands whether or not the model
   * draws: the answer must not depend on what it decides.
   */
  function _trackedOnStation() {
    const tracked = layerState._trackedNorad;
    return (
      stationTrackedOn(norad, tracked, layerState._dockedCompanions) ||
      (tracked !== null && dockedByOrbit.has(tracked))
    );
  }

  /**
   * Leave the near range to the model: the station's dot, and the tracked
   * dot while the tracked satellite is the station, draw only beyond it.
   * Asked every frame (the calls cost nothing when nothing changes): a
   * catalog rebuild or a change of tracked satellite brings new dots that
   * arrive with no range, and a tracked satellite that leaves the station
   * (a vehicle undocking) gets its tracked dot back.
   */
  function _handOverDots() {
    dotHanded = parts.rendering._setPointDisplayRange(norad, farRange);
    const trackedHere = _trackedOnStation();
    if (trackedHere) parts.rendering._setTrackedDotDisplayRange(farRange);
    else if (trackedDotHanded) parts.rendering._setTrackedDotDisplayRange(null);
    trackedDotHanded = trackedHere;
  }

  /** Give the station's dot and the tracked dot back at every distance. */
  function _releaseDots() {
    if (dotHanded) parts.rendering._setPointDisplayRange(norad, null);
    dotHanded = false;
    if (trackedDotHanded) parts.rendering._setTrackedDotDisplayRange(null);
    trackedDotHanded = false;
  }

  /**
   * Objects docked to the station (a module, a crew or cargo ship) have dots
   * of their own at the station's position. Near the model they are part of
   * it, and their dots, moved only a few times a second, jump across the
   * model at 7.6 km/s. While the model shows, their dots draw only beyond its
   * range too. Rescanned once a second: a vehicle that undocks gets its dot
   * back, and a catalog rebuild's new dots are picked up.
   * @param {number} nowMs
   * @param {boolean} handOver Whether the docked dots are left to the model
   *   (it draws); otherwise the scan only keeps the docked set current.
   */
  function _scanCompanions(nowMs, handOver) {
    if (nowMs - lastCompanionScanMs < spec.companionScanMs) return;
    lastCompanionScanMs = nowMs;
    const stationPosition = parts.rendering._pointPosition(norad);
    // The dots are placed at different moments (far apart with the clock sped
    // up), so their spacing only rules out what is nowhere near. Whether an
    // object is docked is read from both orbits at one instant.
    const date = new Date(layerState.now());
    const stationTeme = _temeKm(layerState._catalog.get(norad)?.satrec, date);
    if (!stationPosition || !stationTeme) return;
    for (const [noradId, point] of layerState._points) {
      if (noradId === norad || !point?.pos) continue;
      const entry = layerState._catalog.get(noradId);
      if (entry?.group === 'dense') continue;
      let docked = false;
      if (distance(point.pos, stationPosition) <= spec.companionCoarseM) {
        const teme = _temeKm(entry?.satrec, date);
        docked =
          Boolean(teme) &&
          Math.hypot(
            teme.x - stationTeme.x,
            teme.y - stationTeme.y,
            teme.z - stationTeme.z,
          ) *
            1000 <=
            spec.companionRadiusM;
      }
      if (docked) dockedByOrbit.add(noradId);
      else dockedByOrbit.delete(noradId);
      if (docked && handOver) {
        parts.rendering._setPointDisplayRange(noradId, farRange); // no-op when equal
        handedCompanions.add(noradId);
      } else if (handedCompanions.has(noradId)) {
        parts.rendering._setPointDisplayRange(noradId, null);
        handedCompanions.delete(noradId);
      }
    }
    for (const noradId of dockedByOrbit)
      if (!layerState._points.has(noradId)) dockedByOrbit.delete(noradId);
  }

  /** Give docked objects their dots back at every distance. */
  function _releaseCompanions() {
    for (const noradId of handedCompanions)
      parts.rendering._setPointDisplayRange(noradId, null);
    handedCompanions.clear();
  }

  /** The station's ring back to its own rules (see `syncOrbit`). */
  function _restoreOrbit() {
    if (spec.syncOrbit) {
      spec.syncOrbit();
      return;
    }
    parts.rendering._setOrbitPathShown(
      norad,
      parts.controls.satelliteVisualsVisible(
        layerState._enabled,
        layerState._params.showOrbits,
      ),
    );
  }

  /**
   * Up close the orbit ring (polyline chords, turned once a second) runs off
   * the model and jumps across it, so it is hidden there.
   * @param {boolean} near Camera within `orbitHideM` of the station.
   */
  function _syncOrbitCloseUp(near) {
    if (near) {
      // Kept hidden every frame: the ring may be built after this.
      parts.rendering._setOrbitPathShown(norad, false);
      orbitHidden = true;
    } else if (orbitHidden) {
      orbitHidden = false;
      // Back to the ring's own rules, unless the Cockpit holds it hidden.
      if (layerState._cockpitHiddenPath !== norad) _restoreOrbit();
    }
    // A tracked docked object draws a ring of its own through the model.
    const tracked = layerState._trackedNorad;
    const companion =
      near && tracked !== norad && _trackedOnStation() ? tracked : null;
    if (companionRingHidden !== null && companionRingHidden !== companion) {
      // A tracked satellite's ring shows; untracking has already hidden it.
      if (
        tracked === companionRingHidden &&
        layerState._cockpitHiddenPath !== companionRingHidden
      )
        parts.rendering._setOrbitPathShown(companionRingHidden, true);
      companionRingHidden = null;
    }
    if (companion !== null) {
      parts.rendering._setOrbitPathShown(companion, false);
      companionRingHidden = companion;
    }
  }

  /**
   * Where the station is this frame, and how it is turned: its centre and
   * its flight axes.
   *
   * The follow camera and the Cockpit camera sit on the tracked satellite's
   * per-frame sample. While the tracked satellite is the station (its own
   * entry, or an object docked to it, which has a sample of its own) the
   * model sits on that same sample, or it would be drawn a frame of orbital
   * motion (over 100 m) away from where the camera looks. Otherwise it is
   * placed from the station's own orbit now.
   * @param {{x:number,y:number,z:number}} result Receives the centre.
   * @returns {{date: Date, axes: {x:number[], y:number[], z:number[]}}|null}
   *   Null when the orbit cannot be propagated.
   */
  function _stationFrame(result) {
    const sat = layerState._catalog.get(norad);
    if (!sat) return null;
    const trackedSample =
      _trackedOnStation() && Number.isFinite(layerState._trackedFrameGeo?.atMs)
        ? layerState._trackedFrameGeo
        : null;
    const date = new Date(
      trackedSample ? trackedSample.atMs : layerState.now(),
    );
    let posVel;
    try {
      posVel = propagate(sat.satrec, date);
    } catch {
      posVel = null;
    }
    if (
      !posVel?.position ||
      typeof posVel.position === 'boolean' ||
      !posVel.velocity ||
      typeof posVel.velocity === 'boolean'
    )
      return null;
    const gmst = gstime(date);
    if (trackedSample) {
      // The sample the camera and the tracked dot were placed from.
      copyInto(layerState._trackedFrameCartesian, result);
    } else {
      const geo = eciToGeodetic(posVel.position, gmst);
      copyInto(
        fromRadians(geo.longitude, geo.latitude, geo.height * 1000),
        result,
      );
    }
    const axes = stationFlightAxes(
      result,
      temeToEcefAxes(posVel.velocity, gmst),
    );
    return axes ? { date, axes } : null;
  }

  /**
   * The Cockpit camera's place on the station: one of the views on the
   * model, in the world, worked out from the same sample the model is about
   * to be placed on, so the camera stays on the model however fast the orbit
   * moves it. The spec's `cockpitMount` chooses the view; null for a station
   * without views.
   * @param {string|null} [key] The view asked for; the first on offer when
   *   it is not given or not on offer.
   * @returns {object|null} Null unless the tracked satellite is the station
   *   and the model is loaded and may show.
   */
  function _cockpitMount(key = null) {
    if (!spec.cockpitMount) return null;
    if (!ready || !_trackedOnStation() || !_shouldShow()) return null;
    const frame = _stationFrame(scratchMountCentre);
    if (!frame) return null;
    return spec.cockpitMount({
      key,
      centre: scratchMountCentre,
      axes: frame.axes,
      name: (noradId) => layerState._catalog.get(noradId)?.name ?? null,
      // An entry is offered to ride only when it has a dot to track.
      entry: (noradId) =>
        noradId !== null && layerState._points.has(noradId) ? noradId : null,
      dockedVehicle: _dockedVehicle(),
    });
  }

  /**
   * A vehicle docked to the station (a Progress, a Shenzhou, a Dragon): the
   * tracked one when that is what is tracked, else the lowest catalog number
   * among those docked. The station's own modules have entries too (Zarya,
   * Nauka; Tianhe, Wentian): they are the station, not a vehicle. Null when
   * no vehicle is docked.
   * @returns {number|null}
   */
  function _dockedVehicle() {
    const vehicle = (noradId) =>
      noradId !== norad &&
      !spec.isModule(noradId, layerState._catalog.get(noradId));
    const tracked = layerState._trackedNorad;
    if (tracked !== null && vehicle(tracked)) return tracked;
    let lowest = null;
    for (const group of [dockedByOrbit, layerState._dockedCompanions ?? []])
      for (const noradId of group)
        if (vehicle(noradId) && (lowest === null || noradId < lowest))
          lowest = noradId;
    return lowest;
  }

  /**
   * Per-frame update from the layer's preRender tick.
   * @returns {void}
   */
  function _updateStationModel() {
    visualValid = false;
    // The docked set first: whether the model may show (the Cockpit riding
    // the station) is read from it, so it is kept current before that. Once
    // a second; the dots are handed over or given back with the scan.
    if (item) _scanCompanions(Date.now(), handingOver);
    const show = _shouldShow();
    if (!show) {
      _hide();
      // The dots draw at every distance while the model may not.
      _releaseDots();
      if (handedCompanions.size) _releaseCompanions();
      handingOver = false;
      _syncOrbitCloseUp(false);
      // Off, the layer gives the model's memory back at once; hidden, after
      // a while.
      if (!layerState._enabled) _unload();
      else _undrawn();
      return;
    }
    const dotPosition = parts.rendering._pointPosition(norad);
    const eye = _eye();
    const cameraDistance =
      dotPosition && eye
        ? distance(eye, dotPosition)
        : Number.POSITIVE_INFINITY;
    if (!item) {
      // The file is fetched only once the camera nears the model's range, so
      // a globe-wide view of the layer never downloads it.
      if (
        !loading &&
        !failed &&
        dotPosition &&
        cameraDistance <= spec.maxDistanceM * 1.5
      )
        _load(dotPosition);
      return;
    }
    // Until the renderer has the model loaded and posed, the dots stand at
    // every distance: the station never goes dark while the file loads, nor
    // for good when it fails to.
    if (!ready) {
      _hide();
      _releaseDots();
      if (handedCompanions.size) _releaseCompanions();
      handingOver = false;
      _syncOrbitCloseUp(false);
      if (
        failedAt !== null &&
        Date.now() - failedAt >=
          (spec.retryAfterMs ?? STATION_MODEL_RETRY_AFTER_MS)
      )
        _unload(); // asked for again on the next frame in range
      else if (cameraDistance > spec.maxDistanceM * 1.5) _undrawn();
      else undrawnSince = null;
      return;
    }
    // The docked dots are the model's within its range: handed over at
    // once when the model starts drawing, then with each scan.
    if (!handingOver) {
      handingOver = true;
      lastCompanionScanMs = Number.NEGATIVE_INFINITY;
      _scanCompanions(Date.now(), true);
    }
    _handOverDots();
    _syncOrbitCloseUp(cameraDistance < spec.orbitHideM);
    // Out of range the model would not draw anyway: skip the SGP4 sample.
    if (cameraDistance > spec.maxDistanceM * 1.5) {
      _hide();
      _undrawn();
      return;
    }
    undrawnSince = null;

    const frame = _stationFrame(scratchPosition);
    if (!frame) {
      // Nowhere to draw the model (the orbit would not propagate): the dots
      // draw at every distance rather than nothing at all.
      _hide();
      _releaseDots();
      return;
    }
    const { date, axes } = frame;
    copyInto(scratchPosition, visualPosition);
    copyInto(scratchPosition, item.pos);
    item.orientation = stationModelOrientation(
      scratchPosition,
      axes,
      spec.localAxes,
    );
    telemetry?.touch();
    articulation.update(nodePoses, date, scratchPosition, axes);
    item.show = true;
    _send();
    visualValid = ready;
  }

  /**
   * Where the tracked card should anchor: the station centre the model is
   * rendering at this frame, or null while the model is not drawn (the card
   * then keeps the dot's position). Up close the dot's cache can be a frame
   * ahead of the rendered model, ~130 m of orbit, which shook the card.
   * @returns {{x:number,y:number,z:number}|null}
   */
  function _visualPosition() {
    if (!visualValid || !item?.show) return null;
    const eye = _eye();
    if (eye && distance(eye, visualPosition) > spec.maxDistanceM) return null;
    return visualPosition;
  }

  /**
   * How far the tracked card must stay from its anchor to clear the model, in
   * pixels, or null while the dot shows.
   */
  function _cardClearPx() {
    const position = _visualPosition();
    const pose = findCamera(layerState._viewer)?.pose?.() ?? null;
    const height = canvasOf(layerState._viewer)?.clientHeight;
    const fovy = pose?.fovy;
    if (!position || !height || !fovy) return null;
    const cameraDistance = distance(pose.position, position);
    if (!(cameraDistance > 0)) return null;
    const pixelsPerMeter = height / (2 * Math.tan(fovy / 2)) / cameraDistance;
    return Math.min(
      height * 0.45,
      Math.max(spec.minPx * 0.35, spec.cardClearM * pixelsPerMeter),
    );
  }

  /**
   * The model has not been drawn this frame: once that has lasted
   * `unloadAfterMs`, release it.
   */
  function _undrawn() {
    if (!item) return;
    const nowMs = Date.now();
    undrawnSince ??= nowMs;
    if (
      nowMs - undrawnSince >=
      (spec.unloadAfterMs ?? STATION_MODEL_UNLOAD_AFTER_MS)
    )
      _unload();
  }

  /**
   * Release the model's draw set, and the renderer's model and GPU memory
   * with it; the dots stand at every distance. The next approach loads it
   * again (a failed load is tried again then too).
   */
  function _unload() {
    _releaseDots();
    _releaseCompanions();
    handingOver = false;
    loading = false;
    failed = false;
    failedAt = null;
    ready = false;
    visualValid = false;
    undrawnSince = null;
    offReady?.();
    offFailed?.();
    offReady = null;
    offFailed = null;
    set?.dispose();
    set = null;
    item = null;
  }

  function _destroyStationModel() {
    _unload();
    articulation.reset();
    nodePoses.clear();
    telemetry?.destroy();
    dockedByOrbit.clear();
    lastCompanionScanMs = Number.NEGATIVE_INFINITY;
    _syncOrbitCloseUp(false);
  }

  /** Whether the model is standing in for this docked object's dot. */
  function _standsInFor(noradId) {
    return handedCompanions.has(noradId) && _visualPosition() !== null;
  }

  /**
   * The station's NORAD number when a draw hit landed on its model, so a
   * click on the model tracks the station as a click on its dot does; null
   * for any other hit.
   * @param {{set?: string, id?: string}|null|undefined} hit The click's
   *   `drawHit`.
   * @returns {number|null}
   */
  function _hitNorad(hit) {
    return set && hit?.set === set.id && hit.id === itemId ? norad : null;
  }

  return {
    key: spec.key,
    norad,
    spec,
    _updateStationModel,
    _destroyStationModel,
    _visualPosition,
    _cardClearPx,
    _standsInFor,
    _hitNorad,
    _cockpitMount,
    _trackedOnStation,
    /** Where the joints' angles come from, or null for a station without telemetry. */
    _telemetryStatus: () => telemetry?.status() ?? null,
    /** The joint driver, for the STATION section. */
    _articulation: articulation,
    /** The node matrices the joint driver last wrote, by node name (the item's `nodes`). */
    _nodePoses: nodePoses.poses,
  };
}
