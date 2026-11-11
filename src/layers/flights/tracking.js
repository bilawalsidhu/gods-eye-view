import * as geo from '../../geo/index.js';
import { CYAN } from '../shared/color.js';
import { formatNumber, t } from '../../i18n/index.js';
import { unitLabel } from '../../ui/unitLabels.js';
import { routePlausible } from '../../data/routePlausible.js';
import { createAircraftTracking } from '../aircraft/tracking.js';
import {
  TRACKED_MODEL_MAX_LOAD_FAILS,
  TRACKED_MODEL_RETRY_BACKOFF_MS,
  STALE_ALPHA,
  TRAIL_MAX_POINTS,
  displayDelayMs,
  followsClock,
  DR_CORRECTION_MS,
  TRAIL_COLOR,
  CYAN_TRANSPARENT,
} from './policy.js';

const STALE_CYAN = CYAN.withAlpha(STALE_ALPHA);

/** The civil layer's tracking: the shared aircraft tracking plus the military
 *  suppression handoff and the route-gated tracked card. */
export function createTracking({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { isTr3b, tr3bTypeLabel } = services.aircraftPresentation;
  const { isMilitaryLayerActive, isMilitaryIcao } = services.militaryRegistry;
  const flightsLayer = layer;

  /**
   * The tracked plane's stale cue and whether it is drawn with the stale fade.
   * - SIGNAL LOST · <time since its last report>, dimmed: its coast has ended
   *   (or it holds at its last report after a missed update) and no newer
   *   report has come.
   * - STALE, dimmed: it has missed an update and still coasts, or the whole
   *   feed is backing off.
   * @param {string} icao24
   * @returns {{text: string, dimmed: boolean}}
   */

  function _trackedStaleCue(icao24) {
    const records = flightState.records;
    const misses = records.missingPolls.get(icao24) || 0;
    const repeated = records.fixRepeated?.has(icao24) === true;
    const backoff = flightState.feed._backoff === true;
    // Computed once per frame for the label, the icon colour and the model
    // fade; a poll between frames changes the key.
    const frame = flightState._renderer?.view.frameNumber();
    const key = Number.isFinite(frame)
      ? `${frame}|${icao24}|${misses}|${repeated}|${backoff}`
      : null;
    const cached = flightState._trackedStaleCueCache;
    if (key !== null && cached?.key === key) return cached.cue;
    const cue = _computeTrackedStaleCue(
      icao24,
      misses > 0 || repeated,
      backoff,
    );
    flightState._trackedStaleCueCache = key === null ? null : { key, cue };
    return cue;
  }

  /** `_trackedStaleCue` without the per-frame cache. A repeated fix counts as missed. */

  function _computeTrackedStaleCue(icao24, missed, backoff) {
    const lost = parts.motion._signalLost(icao24);
    if (lost && (missed || !lost.holds)) {
      const sec = Math.max(
        0,
        Math.floor((flightState.now() - lost.reportEpochMs) / 1000),
      );
      const time =
        sec < 60
          ? `${formatNumber(sec, { useGrouping: false })} ${unitLabel('s')}`
          : `${formatNumber(Math.floor(sec / 60), { useGrouping: false })} ${unitLabel('min')}`;
      return { text: t('SIGNAL LOST · {time}', { time }), dimmed: true };
    }
    // A missed update or a stalled feed: no newer position is coming in.
    if (missed || backoff) return { text: t('STALE'), dimmed: true };
    return { text: '', dimmed: false };
  }

  /** The tracked billboard's colour: cyan, faded while stale, clear while the 3D model is the visual. */

  function _trackedIconColor() {
    if (parts.rendering._modelOwnsVisual(flightState._trackedIcao))
      return CYAN_TRANSPARENT;
    return _trackedStaleCue(flightState._trackedIcao).dimmed
      ? STALE_CYAN
      : CYAN;
  }

  /**
   * Re-word the tracked label when its stale cue changes (STALE, SIGNAL LOST,
   * each new second or minute of it). Run from the layer's per-frame pass.
   */

  function _staleCueTick() {
    const icao24 = flightState._trackedIcao;
    if (!icao24 || !flightState._trackedEntity) return;
    const text = _trackedStaleCue(icao24).text;
    if (text === flightState._trackedStaleCueText) return;
    flightState._trackedStaleCueText = text;
    tracking._updateTrackedLabelModel(icao24);
  }

  const tracking = createAircraftTracking({
    flightState,
    services,
    parts,
    layerId: 'flights',
    layerName: 'Live Flights',
    focusId: 'flights',
    logTag: '[Data:Flights]',
    trailHeadIdPrefix: 'fl',
    policy: {
      displayDelayMs,
      followsClock,
      DR_CORRECTION_MS,
      TRAIL_COLOR,
      TRAIL_MAX_POINTS,
      TRACKED_MODEL_MAX_LOAD_FAILS,
      TRACKED_MODEL_RETRY_BACKOFF_MS,
    },
    trackedStyle: {
      get color() {
        return _trackedStaleCue(flightState._trackedIcao).dimmed
          ? STALE_CYAN
          : CYAN;
      },
      transparentColor: CYAN_TRANSPARENT,
      labelColor: '#39d0ff',
      baseScale: 1,
    },
    contactLabel: (icao24, info) => parts.queries._contactLabel(icao24, info),
    trackedLabelText: _trackedLabelText,
    contextFields(icao24, described) {
      const altFt = Math.round((described.altitudeM || 0) * 3.28084);
      const route =
        described.route && _routeIsPlausible(icao24, described.route)
          ? `${described.route.origin.code} → ${described.route.destination.code}`
          : null;
      return {
        label: parts.queries._contactLabel(
          icao24,
          flightState.records.data.get(icao24),
        ),
        operator: described.airline || '',
        type: described.typeName || described.typeCode || '',
        altitude: described.onGround
          ? 'on ground'
          : `${altFt.toLocaleString('en-US')} ft`,
        extra: { route: route || '' },
      };
    },
    // Ground/military-aware restore (a plane untracked while taxiing must come
    // back at ground scale, not full scale).
    fleetBillboardScale: (icao24, meta) =>
      parts.rendering._fleetBillboardScale(icao24, meta?.klass),
    followAltitudeM: (info) => info.altitude,
    onTrackStart(icao24) {
      parts.enrichment._requestTypeEnrichment(icao24, true); // tracked plane — front of the enrichment queue
      parts.enrichment._requestRouteEnrichment(icao24);
      parts.enrichment._requestPhotoEnrichment(icao24);
    },
    // Grounded flights positions are already surface-clamped (the surfaceM
    // chain), so trail seeds/appends drape without a floor of their own.
    floorTrail: false,
    // Leading no-baro waypoints keep the old 10 km airborne default.
  });

  /**
   * Whether the Military layer suppresses this civil duplicate right now.
   *
   * The dedicated Military layer owns icon/track/click for known-military
   * contacts, so the OpenSky duplicate is dropped while that layer is on. Two
   * contacts are exempt, both for the same reason — this layer still owns them:
   *
   *   - the CURRENTLY tracked one, which hands off on untrack; and
   *   - a target this layer is holding on its deferred-restore latch.
   *
   * The second exemption is what makes a shared/local Follow of a mil-registry
   * hex restorable at all. The accepted-snapshot id set is built BEFORE this
   * suppression runs, so without it the target is provably present in a healthy
   * feed yet has no billboard, `trackById` fails, and the restore reports
   * "feed unavailable" about a feed that was perfectly fine.
   *
   * @param {string} icao24 - Normalized ICAO 24-bit address.
   * @returns {boolean} True when the civil duplicate must be dropped.
   */

  function _militaryLayerSuppresses(icao24) {
    if (!isMilitaryLayerActive()) return false;
    if (icao24 === flightState._trackedIcao) return false;
    if (icao24 === flightState._pendingTrackingRestore?.id) return false;
    return true;
  }

  /** Multi-line tracked presentation text: "CS · FL · kts" + "Airline · Type" +
   *  "ORIG → DEST". The route line is gated by
   *  routePlausible so a wrong-leg adsbdb route is hidden, not displayed.
   *  While the plane is in its missed-poll grace (coasting on dead reckoning
   *  with sticky metadata), the first line carries a "· STALE" cue — the fleet's
   *  45%-alpha billboard fade doesn't apply to the tracked plane (its entity
   *  owns the visual), so without this the readout would present last-known
   *  velocity/altitude as live. */

  function _trackedLabelText(icao24) {
    const info = flightState.records.data.get(icao24);
    if (!info) return icao24;
    // A whitespace-only callsign ("   ") is truthy, so `(info.callsign || icao24)`
    // kept it, then .trim() emptied it → the callsign slot dropped out of the
    // readout. `_contactLabel` trims FIRST, then falls through registration to
    // the ICAO hex, so a callsign-less enriched contact heads its readout with
    // the tail number rather than raw hex.
    const cs = parts.queries._contactLabel(icao24, info);
    const altFt = Math.round((info.altitude || 0) * 3.28084);
    // Flight levels are an aviation code; feet and knots read in the active
    // language ("0 фт · 1 уз").
    const quantity = (value, unit) =>
      `${formatNumber(value, { useGrouping: false })} ${unitLabel(unit)}`;
    const fl =
      altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : quantity(altFt, 'ft');
    const spd = info.velocity
      ? quantity(Math.round(info.velocity * 1.944), 'kts')
      : '';
    const stale = _trackedStaleCue(icao24).text;
    const lines = [[cs, fl, spd, stale].filter(Boolean).join(' · ')];
    // Converted contacts report their class as TR-3B and nothing else — the
    // operator/type identity is exactly what the Easter egg is replacing.
    const ident = isTr3b(icao24)
      ? tr3bTypeLabel(icao24)
      : [info.airline, info.typeName || info.typeCode]
          .filter(Boolean)
          .join(' · ');
    if (ident) lines.push(ident);
    if (info.route && _routeIsPlausible(icao24, info.route)) {
      lines.push(`${info.route.origin.code} → ${info.route.destination.code}`);
    }
    return lines.join('\n');
  }

  /** Plausibility check anchored to the plane's billboard position (coarse is
   *  fine here — this gates a LABEL, and it must not touch the tracked frame
   *  cache). Missing data → true (never hide what we can't judge). */

  function _routeIsPlausible(icao24, route) {
    const info = flightState.records.data.get(icao24);
    const bb = flightState._billboards.get(icao24);
    if (!info || !bb || !bb.position) return true;
    const carto = geo.cartographic.fromCartesian(
      bb.position,
      geo.ellipsoid.WGS84,
      flightState._scratchCarto,
    );
    if (!carto) return true;
    return routePlausible({
      latDeg: geo.math.toDegrees(carto.latitude),
      lonDeg: geo.math.toDegrees(carto.longitude),
      altitudeM: info.altitude ?? null,
      verticalRateMps: info.verticalRate ?? null,
      origin: route.origin,
      destination: route.destination,
    });
  }

  /**
   * Immediate military-suppression handoff sweep (pre-ship audit M2).
   *
   * The poll-time suppression branch in update() only reconciles every 30 s, so
   * toggling the Military layer showed duplicate icons (military ON: both layers
   * render the same aircraft ~3-4 km apart) or holes (military OFF: suppressed
   * aircraft absent) for up to a full poll. Fired synchronously by the registry
   * on the active-state TRANSITION:
   *
   *  - activated  → suppress known-military billboards NOW (mirror of the
   *    poll-time branch, tracked aircraft excluded — it hands off on untrack);
   *  - deactivated → the suppressed aircraft's state was deleted, so bring the
   *    next OpenSky poll forward instead of waiting out the interval (update()
   *    itself still honors _retryAt backoff).
   *
   * @param {boolean} active - New military-layer active state.
   * @returns {void}
   */

  function _onMilitaryActiveChange(active) {
    if (!flightState.enabled) return;
    if (active) {
      for (const icao24 of flightState.records.data.keys()) {
        if (!isMilitaryIcao(icao24) || icao24 === flightState._trackedIcao)
          continue;
        const bb = flightState._billboards.get(icao24);
        if (bb) flightState._renderer.fleet.remove(bb);
        flightState._billboards.delete(icao24);
        parts.rendering._releaseModel(icao24); // military-suppression: drop any 3D model too
        flightState.records.forget(icao24);
        flightState._cullPositions.delete(icao24);
        flightState._positionHistory.delete(icao24);
        flightState._displayCourse.delete(icao24);
        flightState._groundSnap.forget(icao24);
        flightState.records.missingPolls.delete(icao24);
      }
      flightState.feed._count = flightState.records.data.size;
    } else {
      // Fire-and-forget refresh; only while the layer is actually enabled.
      // The query reads the renderer's camera (no viewer argument needed).
      void flightsLayer.update(null).catch((error) => {
        // This refresh has no lifecycle-manager caller. Disabling flights
        // cancels it locally; retain visibility of unexpected failures.
        if (error?.name !== 'AbortError') console.error(error);
      });
    }
  }

  return {
    ...tracking,
    _trackedStaleCue,
    _trackedIconColor,
    _staleCueTick,
    _militaryLayerSuppresses,
    _trackedLabelText,
    _routeIsPlausible,
    _onMilitaryActiveChange,
  };
}
