import {
  normalizeHeading,
  roundHeadingDegrees,
} from './data/headingDegrees.js';

export { resolveHudRailLayout } from './ui/panelRailGeometry.js';
export { normalizeHeading };

/**
 * Three-digit heading readout, 000–359.
 * Rounding 359.5° and above lands on north (000), not 360.
 */
export function formatHeadingReadout(degrees) {
  if (!Number.isFinite(degrees)) return '---';
  return String(roundHeadingDegrees(degrees)).padStart(3, '0');
}

/** Advance a displayed heading along the shortest arc without exceeding a slew rate. */
export function slewHeading(current, target, maxStepDeg) {
  const from = normalizeHeading(current);
  const to = normalizeHeading(target);
  if (!Number.isFinite(maxStepDeg) || maxStepDeg <= 0) return from;
  const delta = ((to - from + 540) % 360) - 180;
  const step = Math.max(-maxStepDeg, Math.min(maxStepDeg, delta));
  return normalizeHeading(from + step);
}

/**
 * Return a bounded cockpit-anchor correction for one render step.
 *
 * The cockpit advances inertially from the aircraft's reported course/speed,
 * then uses this amount to converge on the layer's delayed display position.
 * Capping correction below forward speed prevents a late feed fix from
 * becoming a first-person surge or reversal while still removing drift.
 * @param {number} [maxDtSec] The longest step corrected for: 0.1 s, or an
 *   application subject's own (cockpitSubjectStepSec).
 */
export function cockpitAnchorCorrectionStep(
  distanceM,
  speedMps,
  dtSec,
  maxDtSec = 0.1,
) {
  if (
    !Number.isFinite(distanceM) ||
    distanceM <= 0 ||
    !Number.isFinite(dtSec) ||
    dtSec <= 0
  )
    return 0;
  const dt = Math.min(
    Number.isFinite(maxDtSec) && maxDtSec > 0 ? maxDtSec : 0.1,
    dtSec,
  );
  const speed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
  const eased = distanceM * (1 - Math.exp(-1.25 * dt));
  const correctionRateMps = Math.max(0.75, speed * 0.22);
  return Math.min(distanceM, eased, correctionRateMps * dt);
}

/**
 * The seconds an application subject's camera update advances its heading
 * slew, ground lift and anchor by: the time since the last update, at most
 * its update interval plus 0.1 s. A subject updated every 500 ms then turns
 * and eases at its configured rates, while a long stall (a hidden tab) still
 * moves it no further than one late update would.
 * @param {number} elapsedMs Time since the last camera update.
 * @param {number} intervalMs The subject's update interval (0: every frame).
 * @returns {number}
 */
export function cockpitSubjectStepSec(elapsedMs, intervalMs) {
  const elapsedSec = Number.isFinite(elapsedMs)
    ? Math.max(0, elapsedMs) / 1000
    : 0;
  const intervalSec = Number.isFinite(intervalMs)
    ? Math.max(0, intervalMs) / 1000
    : 0;
  return Math.min(intervalSec + 0.1, elapsedSec);
}

/** Return whether a throttled cockpit presentation update is due. */
export function cockpitUiUpdateDue(nowMs, lastUpdateMs, intervalMs) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(intervalMs) || intervalMs < 0)
    return false;
  if (
    !Number.isFinite(lastUpdateMs) ||
    lastUpdateMs <= 0 ||
    nowMs < lastUpdateMs
  )
    return true;
  return nowMs - lastUpdateMs >= intervalMs;
}

/** Return whether the bounded rendered-surface acquisition window has elapsed. */
export function cockpitSurfaceWaitExpired(nowMs, startedMs, timeoutMs = 5000) {
  if (![nowMs, startedMs, timeoutMs].every(Number.isFinite) || timeoutMs < 0)
    return true;
  return nowMs - startedMs >= timeoutMs;
}

/**
 * How fast the clearance a ground clamp adds under an application subject's
 * eye comes and goes (m/s).
 */
export const COCKPIT_SUBJECT_LIFT_MPS = 1.5;

/**
 * The lift the ground clamp gives an application subject's eye this update.
 * The floor is read from coarse cells that refine as tiles load, so the lift
 * it asks for jumps; a ridden eye takes the clearance part of it at
 * `rateMps`, while what it needs to stay out of the floor itself (`hardM`)
 * applies at once.
 * @param {number|null} previousM The lift given last update; null on entry.
 * @param {number} targetM The lift the floor and clearance ask for (m).
 * @param {number} hardM The lift that keeps the eye out of the floor (m).
 * @param {number} dtSec Seconds since the last update.
 * @param {number} [rateMps]
 * @returns {number} At least 0, at least `hardM`.
 */
export function easeCockpitLift(
  previousM,
  targetM,
  hardM,
  dtSec,
  rateMps = COCKPIT_SUBJECT_LIFT_MPS,
) {
  const target = Number.isFinite(targetM) ? Math.max(0, targetM) : 0;
  const hard = Number.isFinite(hardM) ? Math.max(0, hardM) : 0;
  if (!Number.isFinite(previousM)) return Math.max(target, hard);
  const step =
    Math.max(0, Number.isFinite(rateMps) ? rateMps : 0) *
    Math.max(0, Number.isFinite(dtSec) ? dtSec : 0);
  const eased = previousM + Math.max(-step, Math.min(step, target - previousM));
  return Math.max(0, hard, eased);
}

/**
 * Keep the cockpit camera above the shared rendered-surface floor.
 * Unknown floors preserve the proposed camera height.
 */
export function cockpitGroundSafeHeight(
  proposedHeightM,
  groundHeightM,
  clearanceM,
) {
  if (!Number.isFinite(proposedHeightM)) return proposedHeightM;
  if (!Number.isFinite(groundHeightM)) return proposedHeightM;
  const clearance = Number.isFinite(clearanceM) ? Math.max(0, clearanceM) : 0;
  return Math.max(proposedHeightM, groundHeightM + clearance);
}

/**
 * Resolve the cockpit altitude readout without rewriting source aviation data.
 * Confirmed grounded contacts read zero feet; airborne contacts retain MSL.
 */
export function cockpitAltitudeDisplayFt(altitudeM, onGround) {
  if (onGround === true) return 0;
  return Number.isFinite(altitudeM) ? altitudeM * 3.28084 : null;
}

/** The English emergency line; see formatCockpitEmergency. */
const ENGLISH_EMERGENCY = Object.freeze({
  squawk: ({ squawk, label }) => `SQUAWK ${squawk} · ${label}`,
  adsb: ({ priority, label }) =>
    `ADS-B ${priority ? 'PRIORITY' : 'EMERGENCY'} · ${label}`,
});

/**
 * HUD wording for a tracked aircraft's transponder emergency, or null.
 * States what was broadcast, never a conclusion about the flight: the Mode A
 * code when it names the status, else the ADS-B field it came from (an
 * unrelated squawk is dropped).
 * The cockpit passes its own formatter so the page shows it in the active
 * language; this module stays i18n-free.
 * @param {{label?: string, squawk?: string|null,
 *   source?: string, severity?: string}|null|undefined} emergency
 * @param {{squawk: Function, adsb: Function}} [format] Builds the line from
 *   `{ name, label, squawk }` and `{ name, label, priority }`, where
 *   `label` is the upper-cased `name`.
 * @returns {string|null}
 */
export function formatCockpitEmergency(emergency, format = ENGLISH_EMERGENCY) {
  const label = String(emergency?.label || '')
    .trim()
    .toUpperCase();
  if (!label) return null;
  const name = String(emergency.label).trim();
  if (emergency.source === 'squawk' && emergency.squawk)
    return format.squawk({ name, label, squawk: emergency.squawk });
  return format.adsb({
    name,
    label,
    priority: emergency.severity === 'priority',
  });
}

/** The English Context scope line; see formatCockpitContextScope. */
const ENGLISH_CONTEXT_SCOPE = Object.freeze({
  window: ({ label, radiusKm }) =>
    `${label} · ${radiusKm ?? '—'} KM AIR/SEA WINDOW`,
  installations: ({ scope, coverage }) =>
    `${scope} · INSTALLATIONS ${coverage}`,
});

/**
 * Format the cockpit Context scope without overstating installation coverage.
 * @param {string|number} subjectLabel
 * @param {number} radiusM
 * @param {string|null} [installationCoverage]
 * @param {{window: Function, installations: Function}} [format] Builds the
 *   line from `{ label, radiusKm }` (radiusKm is null when unknown) and
 *   `{ scope, coverage }`.
 * @returns {string}
 */
export function formatCockpitContextScope(
  subjectLabel,
  radiusM,
  installationCoverage = null,
  format = ENGLISH_CONTEXT_SCOPE,
) {
  const normalizedLabel =
    typeof subjectLabel === 'string'
      ? subjectLabel.trim() || '—'
      : Number.isFinite(subjectLabel)
        ? String(subjectLabel)
        : '—';
  const radiusKm =
    Number.isFinite(radiusM) && radiusM >= 0
      ? Math.round(radiusM / 1000)
      : null;
  const coverage =
    typeof installationCoverage === 'string' ? installationCoverage.trim() : '';
  const base = format.window({ label: normalizedLabel, radiusKm });
  return coverage ? format.installations({ scope: base, coverage }) : base;
}

/** Return seven 30-degree compass divisions centered on a heading. */
export function compassDivisions(heading) {
  const center = Math.round(normalizeHeading(heading) / 30) * 30;
  return [-90, -60, -30, 0, 30, 60, 90].map((offset) =>
    normalizeHeading(center + offset),
  );
}

/**
 * A heading tape that scrolls continuously: the 30-degree divisions within
 * `reach` divisions of `heading`, each placed by its offset from the exact
 * heading in division slots, so the centre caret reads the heading itself
 * rather than the nearest division. `nearest` marks the division closest to
 * the caret.
 * @param {number} heading Degrees true.
 * @param {number} [reach] Divisions each side of the caret.
 * @returns {Array<{heading: number, slot: number, nearest: boolean}>}
 */
export function scrollingCompassDivisions(heading, reach = 4) {
  if (!Number.isFinite(heading)) return [];
  const exact = normalizeHeading(heading);
  const centre = Math.round(exact / 30) * 30;
  const divisions = [];
  for (let step = -reach; step <= reach; step += 1) {
    const division = normalizeHeading(centre + step * 30);
    divisions.push({
      heading: division,
      slot: Number((relativeBearing(division, exact) / 30).toFixed(4)),
      nearest: step === 0,
    });
  }
  return divisions;
}

/**
 * Where a heading falls on the `scrollingCompassDivisions(tapeHeading)` tape:
 * its offset from the caret (the tape's exact heading) in division slots of
 * 30 degrees, or null when it lies more than three divisions out.
 * @param {number} heading Degrees true.
 * @param {number} tapeHeading The heading under the tape's caret.
 * @returns {?number}
 */
export function compassMarkerSlot(heading, tapeHeading) {
  if (!Number.isFinite(heading) || !Number.isFinite(tapeHeading)) return null;
  const slot = Number((relativeBearing(heading, tapeHeading) / 30).toFixed(4));
  return Math.abs(slot) <= 3 ? slot : null;
}

/** Format a compass division as a cardinal/intercardinal label or degrees. */
export function formatCompassDivision(heading) {
  const normalized = normalizeHeading(heading);
  const labels = new Map([
    [0, 'N'],
    [45, 'NE'],
    [90, 'E'],
    [135, 'SE'],
    [180, 'S'],
    [225, 'SW'],
    [270, 'W'],
    [315, 'NW'],
  ]);
  return (
    labels.get(normalized) || String(Math.round(normalized)).padStart(3, '0')
  );
}

/** Choose a readable altitude-tape interval for the current flight level. */
export function altitudeRulerStep(altitudeFt) {
  if (!Number.isFinite(altitudeFt)) return 500;
  const altitude = Math.max(0, altitudeFt);
  if (altitude < 5000) return 100;
  if (altitude < 15000) return 250;
  return 500;
}

/**
 * Return an odd number of altitude ticks whose fractional slots move smoothly
 * behind a fixed center pointer as altitude changes.
 */
export function altitudeRulerTicks(altitudeFt, count = 9) {
  if (!Number.isFinite(altitudeFt)) return [];
  const tickCount = Math.max(3, Math.floor(count) | 1);
  const altitude = Math.max(0, altitudeFt);
  const stepFt = altitudeRulerStep(altitude);
  const altitudeUnits = altitude / stepFt;
  const anchorUnits = Math.floor(altitudeUnits);
  const half = Math.floor(tickCount / 2);
  return Array.from({ length: tickCount }, (_, index) => {
    const tickUnits = anchorUnits + index - half;
    const slot = tickUnits - altitudeUnits;
    return {
      valueFt: Math.max(0, tickUnits * stepFt),
      slot,
      depth: Math.abs(slot),
      major: tickUnits % 2 === 0,
      stepFt,
    };
  });
}

/**
 * Return the horizontal inset needed to keep an altitude tick on a circular
 * keyhole rim. The tape places each slot at 8% of its diameter vertically.
 */
export function altitudeRulerCurveInset(slot) {
  if (!Number.isFinite(slot)) return 0;
  const normalizedY = Math.min(0.92, Math.abs(slot) * 0.16);
  return 1 - Math.sqrt(1 - normalizedY ** 2);
}

/** Render altitude-tape values as stable five-character flight-deck labels. */
export function formatAltitudeRulerTick(valueFt) {
  if (!Number.isFinite(valueFt)) return '-----';
  return String(Math.max(0, Math.round(valueFt))).padStart(5, '0');
}

/** Choose a readable speed-tape interval for the current ground speed. */
export function speedRulerStep(speedKt) {
  if (!Number.isFinite(speedKt)) return 25;
  const speed = Math.max(0, speedKt);
  if (speed < 100) return 10;
  if (speed < 300) return 20;
  return 25;
}

/** Return moving speed ticks behind a fixed current-speed pointer. */
export function speedRulerTicks(speedKt, count = 9) {
  if (!Number.isFinite(speedKt)) return [];
  const tickCount = Math.max(3, Math.floor(count) | 1);
  const speed = Math.max(0, speedKt);
  const stepKt = speedRulerStep(speed);
  const speedUnits = speed / stepKt;
  const anchorUnits = Math.floor(speedUnits);
  const half = Math.floor(tickCount / 2);
  return Array.from({ length: tickCount }, (_, index) => {
    const tickUnits = anchorUnits + index - half;
    const slot = tickUnits - speedUnits;
    return {
      valueKt: Math.max(0, tickUnits * stepKt),
      slot,
      depth: Math.abs(slot),
      major: tickUnits % 2 === 0,
      stepKt,
    };
  });
}

/** Render speed-tape values as stable three-character flight-deck labels. */
export function formatSpeedRulerTick(valueKt) {
  if (!Number.isFinite(valueKt)) return '---';
  return String(Math.max(0, Math.round(valueKt))).padStart(3, '0');
}

/** Return the initial great-circle bearing between two latitude/longitude points. */
export function bearingBetweenCoordinates(fromLat, fromLon, toLat, toLon) {
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) return null;
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const Δλ = ((toLon - fromLon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return null;
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

/** Return a target bearing relative to the current heading in the [-180, 180) range. */
export function relativeBearing(bearing, heading) {
  if (!Number.isFinite(bearing) || !Number.isFinite(heading)) return null;
  return (
    ((normalizeHeading(bearing) - normalizeHeading(heading) + 540) % 360) - 180
  );
}

/**
 * Resolve which flight layer owns the cockpit's tracked aircraft.
 *
 * Both layers can briefly describe a tracked aircraft during a cross-layer
 * handoff, so the viewer's normalized tracked identity (`gevTrackedId`) is the
 * tie-breaker — the same rule `militaryAwareness.currentTrackedFlightSubject`
 * uses. Layer precedence remains the fallback when no normalized identity is
 * available, so tracking paths that never stamp one keep working.
 * @param {object} [options] Candidate descriptors and the tracked identity.
 * @param {object|null} [options.civilian] `flightsLayer.getTrackedInfo()` result.
 * @param {object|null} [options.military] `militaryFlightsLayer.getTrackedInfo()` result.
 * @param {string} [options.trackedId] Normalized `<layerId>:<icao24>` tracked identity.
 * @returns {object|null} The owning layer's info stamped with its `layerId`.
 */
export function resolveTrackedAircraftInfo({
  civilian = null,
  military = null,
  trackedId = '',
} = {}) {
  const candidates = [];
  if (civilian) candidates.push({ ...civilian, layerId: 'flights' });
  if (military) candidates.push({ ...military, layerId: 'military' });
  if (!candidates.length) return null;
  const trackedKey = String(trackedId || '')
    .trim()
    .toLowerCase();
  if (trackedKey) {
    const owner = candidates.find(
      (candidate) =>
        `${candidate.layerId}:${candidate.icao24}`.toLowerCase() === trackedKey,
    );
    if (owner) return owner;
  }
  return candidates[0];
}

/**
 * Decide how the cockpit Contact panel renders the current context snapshot.
 *
 * The panel hosts its own PREVIOUS/NEXT controls, so its visibility can only
 * depend on whether a snapshot exists — never on which subject that snapshot
 * happens to describe. Anything else strands the operator the moment NEXT
 * lands on a contact that is not the tracked aircraft.
 * @param {object} [options] Resolver inputs.
 * @param {object|null} [options.snapshot] `militaryAwareness.getContextSnapshot()` result.
 * @param {object|null} [options.info] Tracked aircraft info from the owning flight layer.
 * @returns {{visible: boolean, mode: string, subjectMatchesTracked: boolean,
 *   aircraftRelative: boolean, contactLost: boolean}}
 *   Panel visibility plus the per-field rendering rules for this frame.
 */
export function resolveCockpitContextReadout({
  snapshot = null,
  info = null,
} = {}) {
  if (!snapshot) {
    return {
      visible: false,
      mode: 'standby',
      subjectMatchesTracked: false,
      aircraftRelative: false,
      contactLost: false,
    };
  }
  const trackedId = info?.icao24 ?? info?.id;
  const subjectMatchesTracked =
    snapshot.subject?.layerId === info?.layerId &&
    String(snapshot.subject?.id) === String(trackedId);
  // `subjectPresent` is absent on snapshots built before the presence signal
  // existed; only an explicit `false` means the subject left its source.
  const contactLost = snapshot.subjectPresent === false;
  return {
    visible: true,
    mode: contactLost ? 'lost' : subjectMatchesTracked ? 'tracked' : 'foreign',
    subjectMatchesTracked,
    // The nose-relative arrow and BRG readout are measured in the tracked
    // aircraft's own frame; every other value in that row is measured from the
    // subject. When they are not the same contact, rendering both live shows
    // one mixed-frame reading as a single measurement, so the aircraft-frame
    // half is dashed instead.
    aircraftRelative: subjectMatchesTracked,
    // A lost contact holds its last-known values: recomputing them against a
    // frozen position would present stale geometry as a live reading.
    contactLost,
  };
}
