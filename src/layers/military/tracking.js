import { t } from '../../i18n/index.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import { createAircraftTracking } from '../aircraft/tracking.js';
import {
  TRACKED_MODEL_MAX_LOAD_FAILS,
  TRACKED_MODEL_RETRY_BACKOFF_MS,
  TRAIL_MAX_POINTS,
  RENDER_DELAY_SEC,
  TRAIL_COLOR,
  BILLBOARD_SCALE,
  GROUND_SCALE,
  AMBER_TRANSPARENT,
  TRACKED_ICON_COLOR,
} from './policy.js';

/** The military layer's tracking: the shared aircraft tracking with the amber
 *  tracked card and trails floored at the warm ground. */
export function createTracking({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { tr3bTypeLabel } = services.aircraftPresentation;

  const tracking = createAircraftTracking({
    flightState,
    services,
    parts,
    layerId: 'military',
    layerName: 'Military Flights',
    focusId: 'militaryFlights',
    logTag: '[Data:Military]',
    trailHeadIdPrefix: 'mil',
    policy: {
      RENDER_DELAY_SEC,
      TRAIL_COLOR,
      TRAIL_MAX_POINTS,
      TRACKED_MODEL_MAX_LOAD_FAILS,
      TRACKED_MODEL_RETRY_BACKOFF_MS,
    },
    trackedStyle: {
      color: TRACKED_ICON_COLOR,
      transparentColor: AMBER_TRANSPARENT,
      labelColor: '#ffd166',
      baseScale: BILLBOARD_SCALE,
    },
    contactLabel: (icao24, info) =>
      parts.queries._toCleanText(info.callsign) ||
      parts.queries._toCleanText(info.registration) ||
      icao24,
    trackedLabelText: (icao24) =>
      _buildTrackedLabel(flightState.records.data.get(icao24), icao24),
    contextFields(icao24, described) {
      const info = flightState.records.data.get(icao24);
      return {
        label: described.callsign || described.registration || icao24,
        operator: parts.queries._toCleanText(info?.operator) || '',
        // Converted contacts report their class as TR-3B — the same override
        // the readout and Contacts card show.
        type: tr3bTypeLabel(
          icao24,
          parts.queries._toCleanText(info?.type) || '',
        ),
        altitude: described.onGround
          ? 'on ground'
          : parts.queries._formatAltitude(info?.altitudeFt),
        extra: {},
      };
    },
    // Ground-aware restore (a plane untracked while taxiing comes back at
    // ground scale).
    fleetBillboardScale: (icao24, meta) =>
      BILLBOARD_SCALE *
      (CLASS_SCALE_2D[meta?.klass] || 1) *
      (meta?.onGround ? GROUND_SCALE : 1),
    followAltitudeM: (info) =>
      info?.altitudeFt ? info.altitudeFt * 0.3048 : null,
    // Grounded military billboards keep the pre-datum default height (T7
    // groundSnap invariant), so the trail lifts its own positions instead.
    floorTrail: true,
    // Leading 'ground'/null trace points keep the old low breadcrumb sentinel
    // (an arbitrary placeholder, never a reported altitude); the ~24 h trace
    // is thinned to the vertex budget.
    backfill: { leadAltM: 50, thinToBudget: true },
  });

  /**
   * Build the multi-line presentation text for the protected tracked host card.
   * Lines: callsign, type/registration, operator/altitude.
   * While the plane is in its missed-poll grace (coasting on dead reckoning
   * with sticky metadata) the first line carries a "· STALE" cue — the fleet's
   * 45%-alpha billboard fade doesn't apply to the tracked plane (its entity
   * owns the visual), so without this the readout would present last-known
   * altitude/speed as live.
   * @param {Object|null} info - Flight metadata from _flightData
   * @param {string} icao24 - ICAO hex identifier (fallback display name)
   * @returns {string} Newline-separated label text
   */

  function _buildTrackedLabel(info, icao24) {
    const stale =
      flightState.records.missingPolls.get(icao24) || flightState.feed._backoff
        ? ` · ${t('STALE')}`
        : '';
    const callsign =
      (parts.queries._toCleanText(info?.callsign) ||
        parts.queries._toCleanText(info?.registration) ||
        icao24) + stale;
    // Converted contacts report their class as TR-3B — that override is exactly
    // what the Easter egg replaces the real type with.
    const type = tr3bTypeLabel(
      icao24,
      parts.queries._toCleanText(info?.type) || t('Type unknown'),
    );
    const registration =
      parts.queries._toCleanText(info?.registration) || t('Reg unknown');
    const operator =
      parts.queries._toCleanText(info?.operator) || t('Operator unknown');
    const altitude = parts.queries._formatAltitude(info?.altitudeFt);
    const speedKt = info?.speedMps ? Math.round(info.speedMps * 1.944) : null;
    const tail = speedKt ? `${altitude} · ${speedKt} kt` : altitude;
    return [
      callsign,
      `${type} · ${registration}`,
      `${operator} · ${tail}`,
    ].join('\n');
  }

  return { ...tracking, _buildTrackedLabel };
}
