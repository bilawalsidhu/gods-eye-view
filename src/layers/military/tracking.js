import { formatNumber, t } from '../../i18n/index.js';
import { unitLabel } from '../../ui/unitLabels.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
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
  BILLBOARD_SCALE,
  GROUND_SCALE,
  AMBER_TRANSPARENT,
  TRACKED_ICON_COLOR,
} from './policy.js';

const STALE_TRACKED_COLOR = TRACKED_ICON_COLOR.withAlpha(STALE_ALPHA);

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

  /** The tracked billboard's colour: amber, faded while stale, clear while the 3D model is the visual. */

  function _trackedIconColor() {
    if (parts.rendering._modelOwnsVisual(flightState._trackedIcao))
      return AMBER_TRANSPARENT;
    return _trackedStaleCue(flightState._trackedIcao).dimmed
      ? STALE_TRACKED_COLOR
      : TRACKED_ICON_COLOR;
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
    layerId: 'military',
    layerName: 'Military Flights',
    focusId: 'militaryFlights',
    logTag: '[Data:Military]',
    trailHeadIdPrefix: 'mil',
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
          ? STALE_TRACKED_COLOR
          : TRACKED_ICON_COLOR;
      },
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
    const cue = _trackedStaleCue(icao24).text;
    const stale = cue ? ` · ${cue}` : '';
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

  return {
    ...tracking,
    _buildTrackedLabel,
    _trackedStaleCue,
    _trackedIconColor,
    _staleCueTick,
  };
}
