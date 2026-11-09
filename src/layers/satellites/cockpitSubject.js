import * as Cesium from 'cesium';
import { satelliteClassText } from '../../data/satelliteClass.js';
import {
  classifySatellite,
  cosparIdFromTleLine1,
  satelliteClassEnterable,
  satelliteOperator,
  satelliteOwner,
  tleEpochMs,
} from './classes.js';
import { ISS_NORAD } from './policy.js';

/** The layer id a satellite subject carries through Cockpit events and state. */
export const SATELLITE_COCKPIT_LAYER_ID = 'satellites';

/**
 * While the Cockpit rides a satellite, every other orbit ring (the ISS ring
 * included) draws at this fraction of its normal alpha, so the rings stay
 * legible without competing with the nadir picture.
 */
export const COCKPIT_ORBIT_DIM_FACTOR = 0.3;

/**
 * Write an orbit ring's alpha as a multiple of the alpha it was built with.
 * The ring's per-instance attributes exist only once Cesium has updated the
 * primitive; until then nothing is written and the next tick retries.
 * @param {{primitive: object, instanceId: string, baseColor: Cesium.Color,
 *   baseDepthFailColor: Cesium.Color, alphaFactor: number}} path
 * @param {number} factor 1 restores the built colours exactly.
 * @returns {boolean} True when the ring now carries `factor`.
 */
export function applyOrbitPathAlpha(path, factor) {
  if (!path?.primitive || !path.baseColor) return false;
  if ((path.alphaFactor ?? 1) === factor) return true;
  let attributes;
  try {
    attributes = path.primitive.getGeometryInstanceAttributes?.(
      path.instanceId,
    );
  } catch {
    return false;
  }
  if (!attributes) return false;
  const scaled = (color) => color.withAlpha(color.alpha * factor);
  attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
    factor === 1 ? path.baseColor : scaled(path.baseColor),
  );
  attributes.depthFailColor = Cesium.ColorGeometryInstanceAttribute.toValue(
    factor === 1 ? path.baseDepthFailColor : scaled(path.baseDepthFailColor),
  );
  path.alphaFactor = factor;
  return true;
}

/**
 * Who and what a catalog entry is: class, COSPAR id, TLE, owner, operator.
 * Fixed for the entry's life, so it is worked out once and kept on it.
 * @param {number} noradId
 * @param {object} sat Catalog entry.
 */
function satelliteIdentity(noradId, sat) {
  if (sat.cockpitIdentity) return sat.cockpitIdentity;
  const satelliteClass =
    sat.satelliteClass ||
    classifySatellite({ noradId, name: sat.name, group: sat.group });
  const epochMs = tleEpochMs(sat.satrec);
  const identity = Object.freeze({
    satelliteClass,
    cosparId: sat.satcat?.cosparId || cosparIdFromTleLine1(sat.line1),
    tle:
      sat.line1 && sat.line2 && epochMs !== null
        ? Object.freeze({ line1: sat.line1, line2: sat.line2, epochMs })
        : null,
    owner: freezeOwner(
      satelliteOwner({ ucs: sat.ucs, satcat: sat.satcat, satelliteClass }),
    ),
    operator: satelliteOperator({ ucs: sat.ucs, satelliteClass }),
    // src/layers/satellites/sensors.js entry, or null: the orbital view's sensor swath.
    sensor: sat.sensor ?? null,
  });
  sat.cockpitIdentity = identity;
  return identity;
}

function freezeOwner(owner) {
  return owner
    ? Object.freeze({
        countryCode: owner.countryCode ?? null,
        label: owner.label ?? null,
      })
    : null;
}

/**
 * Normalize the tracked satellite and its per-frame fix into Cockpit subject
 * info, in the shape every Cockpit subject kind shares.
 * @param {number} noradId NORAD catalog number.
 * @param {{name?: string, group?: string}|null} sat Catalog entry.
 * @param {{latitude: number, longitude: number, altitude: number,
 *   speedMps?: number|null, groundTrackDeg?: number|null, atMs?: number}|null}
 *   fix Per-frame SGP4 sample (orbits.js propagatePosition), at `atMs`.
 * @returns {object|null} Subject info, or null without a usable fix.
 */
export function satelliteCockpitInfo(noradId, sat, fix) {
  if (!sat || !fix) return null;
  const { latitude, longitude, altitude } = fix;
  if (![latitude, longitude, altitude].every(Number.isFinite)) return null;
  const isIss = noradId === ISS_NORAD;
  const identity = satelliteIdentity(noradId, sat);
  return {
    kind: 'satellite',
    layerId: SATELLITE_COCKPIT_LAYER_ID,
    id: String(noradId),
    noradId,
    name: sat.name?.trim() || `SAT-${noradId}`,
    // Localized at read time, as the vessel layer's type label is.
    classLabel: satelliteClassText(identity.satelliteClass, sat.group, {
      isIss,
    }),
    latitude,
    longitude,
    altitudeM: altitude,
    // SGP4's TEME velocity: the inertial orbital speed, not ground speed.
    velocityMps: Number.isFinite(fix.speedMps) ? fix.speedMps : null,
    // The time the position is at (epoch ms), the satellites' world-clock
    // time; null when the sample does not say.
    atMs: Number.isFinite(fix.atMs) ? fix.atMs : null,
    // Degrees clockwise from north; null for a geostationary satellite.
    groundTrackDeg: Number.isFinite(fix.groundTrackDeg)
      ? fix.groundTrackDeg
      : null,
    stale: false,
    // src/layers/satellites/classes.js: 'stations'|'imaging'|'telecom'|'starlink'|
    // 'probes'|'debris'.
    satelliteClass: identity.satelliteClass,
    // Whether its class may be ridden in the orbital view (debris may not);
    // the Cockpit's entry gate reads it (orbitEntryAllowed).
    enterable: satelliteClassEnterable(identity.satelliteClass),
    // International designator, e.g. '1998-067A'.
    cosparId: identity.cosparId,
    tle: identity.tle,
    // { countryCode: ISO 3166-1 alpha-2 or null (organisations, joint
    // owners), label: English name } or null.
    owner: identity.owner,
    operator: identity.operator,
    sensor: identity.sensor,
  };
}

/**
 * The tracked satellite as a Cockpit orbital-view subject, and the hold that
 * hides its own marks while the Cockpit camera rides it.
 *
 * While held, the tracked dot is hidden (it would sit on the lens), as are
 * the point primitives of docked companions (they share the position within
 * 2 km) and the subject's orbit ring: a nadir camera on the ring sees its far
 * side, dimmed by the ring's depth-fail appearance, drawn straight across the
 * Earth's disk. The detection overlay skips the subject too. The tracked
 * card needs nothing here: its overlay source already hides in Cockpit mode.
 * Every other orbit ring is dimmed to COCKPIT_ORBIT_DIM_FACTOR of its alpha
 * while a subject is set; other satellites' points and labels stay as they
 * are. Scene clicks and the layer's Escape are ignored while held, so the
 * picture cannot untrack its own subject. Release restores exactly what the
 * hold hid or dimmed.
 */
export function createCockpitSubject({ state: layerState, parts }) {
  /** The subject is held only while it is the tracked satellite. */
  function _cockpitHeld() {
    return (
      layerState._cockpitSubjectNorad !== null &&
      layerState._cockpitSubjectNorad === layerState._trackedNorad
    );
  }

  function _setPointShown(noradId, show) {
    const point = layerState._points.get(noradId);
    // Released points go back to their class's visibility.
    if (point) point.show = show && parts.controls._classVisible(noradId);
  }

  /**
   * Apply or release the hold. Idempotent, and cheap enough for the preRender
   * tick, which re-applies it while held so catalog rebuilds, enable and the
   * orbit toggle cannot re-show what the hold hides.
   * @returns {void}
   */
  function _syncCockpitSubjectVisuals() {
    const held = _cockpitHeld();
    const tracked = layerState._trackedNorad;

    const dot = layerState._trackedEntity?.point;
    if (held) {
      if (dot) dot.show = false;
      layerState._cockpitHiddenDot = true;
    } else if (layerState._cockpitHiddenDot) {
      if (dot) dot.show = true;
      layerState._cockpitHiddenDot = false;
    }

    const hiddenPoints = layerState._cockpitHiddenPoints;
    const companions = held ? layerState._dockedCompanions : new Set();
    for (const noradId of [...hiddenPoints]) {
      if (companions.has(noradId)) continue;
      hiddenPoints.delete(noradId);
      // The tracked primitive stays hidden: its entity draws the dot.
      if (noradId !== tracked) _setPointShown(noradId, true);
    }
    // Re-applied every sync: a catalog rebuild replaces the point
    // primitives, and the new ones arrive shown.
    for (const noradId of companions) {
      if (noradId === tracked) continue;
      hiddenPoints.add(noradId);
      _setPointShown(noradId, false);
    }
    if (held) {
      const trackedPoint = layerState._points.get(tracked);
      if (trackedPoint) trackedPoint.show = false;
    }

    const hiddenPath = layerState._cockpitHiddenPath;
    if (hiddenPath !== null && (!held || hiddenPath !== tracked)) {
      const path = layerState._orbitPaths.get(hiddenPath);
      // The ISS's ring also follows its class (and its tracking).
      if (path && hiddenPath === ISS_NORAD) parts.controls._syncIssOrbit();
      else if (path)
        path.primitive.show = parts.controls.satelliteVisualsVisible(
          layerState._enabled,
          layerState._params.showOrbits,
        );
      layerState._cockpitHiddenPath = null;
    }
    if (held) {
      const path = layerState._orbitPaths.get(tracked);
      if (path) {
        path.primitive.show = false;
        layerState._cockpitHiddenPath = tracked;
      }
    }

    // Every other ring is dimmed for the whole session and restored on
    // release; rebuilt rings arrive at full alpha and are dimmed again here.
    const subject = layerState._cockpitSubjectNorad;
    for (const [noradId, path] of layerState._orbitPaths) {
      const dim = subject !== null && noradId !== subject;
      applyOrbitPathAlpha(path, dim ? COCKPIT_ORBIT_DIM_FACTOR : 1);
    }
  }

  const methods = {
    /**
     * The tracked satellite as Cockpit subject info, from the same per-frame
     * SGP4 sample the dot and the follow camera use.
     * @returns {{kind: 'satellite', layerId: 'satellites', id: string,
     *   noradId: number, name: string, classLabel: string,
     *   latitude: number, longitude: number, altitudeM: number,
     *   velocityMps: number|null, stale: false,
     *   satelliteClass: 'stations'|'imaging'|'telecom'|'starlink'|'probes'|'debris',
     *   cosparId: string|null,
     *   tle: {line1: string, line2: string, epochMs: number}|null,
     *   owner: {countryCode: string|null, label: string|null}|null,
     *   operator: string|null}|null} Null while the layer is off or nothing
     *   is tracked.
     */
    getCockpitSubject() {
      if (!layerState._enabled || layerState._trackedNorad === null)
        return null;
      const noradId = layerState._trackedNorad;
      return satelliteCockpitInfo(
        noradId,
        layerState._catalog.get(noradId),
        parts.tracking._getTrackedFramePosition(),
      );
    },

    /**
     * The tracked satellite's Earth-fixed position this frame: the per-frame
     * cache the dot and follow camera read, never a separate propagation.
     * @param {Cesium.Cartesian3} [result] Receives the position.
     * @returns {Cesium.Cartesian3|null} Null while the layer is off, nothing
     *   is tracked or no sample has propagated.
     */
    getCockpitPosition(result) {
      if (!layerState._enabled || layerState._trackedNorad === null)
        return null;
      if (!parts.tracking._getTrackedFramePosition()) return null;
      return Cesium.Cartesian3.clone(layerState._trackedFrameCartesian, result);
    },

    /**
     * Mark the satellite whose position the Cockpit camera occupies, or
     * release it. The hold applies while that satellite is tracked.
     * @param {string|number|null} noradId Subject NORAD id, or null to release.
     * @returns {boolean} Always true.
     */
    setCockpitSubject(noradId) {
      const next =
        noradId === null || noradId === undefined
          ? null
          : parts.tracking._normalizeTrackedNorad(noradId);
      if (layerState._cockpitSubjectNorad === next) return true;
      layerState._cockpitSubjectNorad = next;
      _syncCockpitSubjectVisuals();
      return true;
    },

    /**
     * Put the follow camera back on the tracked satellite after the Cockpit
     * released it, without re-tracking (no new selection or context events).
     * @param {string|number} noradId The satellite the Cockpit rode.
     * @returns {boolean} True when that satellite is still tracked and the
     *   follow camera was restored.
     */
    refocusTrackedById(noradId) {
      const id = parts.tracking._normalizeTrackedNorad(noradId);
      const viewer = layerState._viewer;
      const entity = layerState._trackedEntity;
      if (
        id === null ||
        id !== layerState._trackedNorad ||
        !viewer ||
        !entity ||
        !viewer.entities?.contains?.(entity)
      )
        return false;
      viewer.camera?.cancelFlight?.();
      viewer.trackedEntity = entity;
      return true;
    },
  };

  return { _cockpitHeld, _syncCockpitSubjectVisuals, methods };
}
