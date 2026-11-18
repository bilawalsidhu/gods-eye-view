/**
 * @module layers/rail/stopLabels
 * @description Which stops of a selected train's trip the map labels, the
 * colour of each label's time chip, and the shared-overlay entries for them.
 *
 * Stops come from an injected provider (see createRailLayer in index.js),
 * normally the stop list railSchedule.tripStops() returns. The fields read
 * here are:
 *
 *   {
 *     stopId: string,
 *     name: string,
 *     parentName?: string|null,     // the station a platform stop belongs to
 *     lat: number, lon: number,
 *     state: 'passed' | 'next' | 'upcoming',
 *     atStop?: boolean,              // the train dwells at its next stop
 *     relative: string,              // 'T−4' (due in 4 min), 'T+3' (3 min ago)
 *     expectedArrival?: string,      // 24 h, station local time: '14:32'
 *     expectedDeparture?: string,
 *     arrivalDelaySec?: number,      // expected minus timetable
 *     departureDelaySec?: number,
 *     skipped?: boolean,             // cancelled at this stop
 *     passThrough?: boolean,         // the train runs through without stopping
 *   }
 *
 * The clock and the delay shown are those of the event `relative` counts to:
 * the departure from a stop passed or dwelt at, else the arrival.
 *
 * The map labels at most four stops: the stop just passed, the next stop, the
 * stop after it and the terminus. Every other stop is a dot without a label.
 *
 * Pure: no Cesium, no DOM. The caller supplies anchors.
 */

/** Overlay source for the selected train's stop labels. */
export const RAIL_STOP_OVERLAY_SOURCE_ID = 'rail-stops';
export const RAIL_STOP_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 4,
  collisionCapacity: 4,
  maxVisible: 4,
  moving: false,
});

/** A stop this late or later shows an amber time chip (ms). */
export const STOP_LATE_MS = 3 * 60_000;
/** ...and this late or later, a red one (ms). */
export const STOP_VERY_LATE_MS = 10 * 60_000;

/** Time-chip colours: on time, late, very late. */
export const STOP_CHIP_COLORS = Object.freeze({
  onTime: '#C9D1D9',
  late: '#FFB020',
  veryLate: '#FF4D4F',
});

/** Label roles, most important first for the overlay host. */
const ROLE_PRIORITY = Object.freeze({
  next: 4,
  previous: 3,
  afterNext: 2,
  terminus: 1,
});

/** Above any ambient label another layer publishes. */
const STOP_LABEL_BASE_PRIORITY = 1e12;

/**
 * The name a stop is shown by: its station's, when the timetable lists the
 * platform as a child of one ("Town Hall Station", not "Town Hall Station
 * Platform 3"), else its own.
 * @param {object} stop
 * @returns {string}
 */
export function stopName(stop) {
  const station =
    typeof stop?.parentName === 'string' ? stop.parentName.trim() : '';
  if (station) return station;
  return typeof stop?.name === 'string' ? stop.name.trim() : '';
}

/** Whether a value is a drawable stop: named and placed. */
function placedStop(stop) {
  return (
    !!stop &&
    stopName(stop) !== '' &&
    Number.isFinite(stop.lat) &&
    Number.isFinite(stop.lon) &&
    Math.abs(stop.lat) <= 90
  );
}

/** Whether the train calls at a stop: worth a label, a card line, a role. */
function callingStop(stop) {
  return placedStop(stop) && stop.skipped !== true && stop.passThrough !== true;
}

/** Whether the stop's shown event is its departure rather than its arrival. */
function showsDeparture(stop) {
  return stop?.state === 'passed' || stop?.atStop === true;
}

/**
 * The 24 h station-local clock of the stop's shown event.
 * @param {object} stop
 * @returns {string}
 */
export function stopClock(stop) {
  const departure = showsDeparture(stop);
  const first = departure ? stop?.expectedDeparture : stop?.expectedArrival;
  const other = departure ? stop?.expectedArrival : stop?.expectedDeparture;
  if (typeof first === 'string' && first) return first;
  return typeof other === 'string' ? other : '';
}

/**
 * How late the stop's shown event is expected, in ms (never negative: an
 * early train is on time for the chip), or NaN when the delay is unknown.
 * @param {object} stop
 * @returns {number}
 */
export function stopDelayMs(stop) {
  const departure = showsDeparture(stop);
  const first = departure ? stop?.departureDelaySec : stop?.arrivalDelaySec;
  const other = departure ? stop?.arrivalDelaySec : stop?.departureDelaySec;
  // Only a number is a delay: null or a string is "unknown", not zero.
  const seconds = Number.isFinite(first) ? first : other;
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : NaN;
}

/**
 * The time-chip colour for a delay.
 * @param {number} delayMs
 * @returns {string}
 */
export function stopChipColor(delayMs) {
  if (Number.isFinite(delayMs) && delayMs >= STOP_VERY_LATE_MS)
    return STOP_CHIP_COLORS.veryLate;
  if (Number.isFinite(delayMs) && delayMs >= STOP_LATE_MS)
    return STOP_CHIP_COLORS.late;
  return STOP_CHIP_COLORS.onTime;
}

/**
 * Whole minutes late, for the card's "(+n min late)", or 0 when on time or
 * unknown.
 * @param {object} stop
 * @returns {number}
 */
export function stopLateMinutes(stop) {
  const delay = stopDelayMs(stop);
  return Number.isFinite(delay) ? Math.round(delay / 60_000) : 0;
}

/**
 * The stop just passed and the next stop of a trip, among the stops the train
 * calls at. The next stop is the one the timetable marks `next`, else the
 * first not yet passed; the previous is the last passed stop before it.
 * @param {object[]} stops In trip order.
 * @returns {{previous: number, next: number}} Indices, -1 when absent.
 */
export function stopRoleIndices(stops) {
  const list = Array.isArray(stops) ? stops : [];
  let next = list.findIndex(
    (stop) => callingStop(stop) && stop.state === 'next',
  );
  if (next < 0)
    next = list.findIndex(
      (stop) => callingStop(stop) && stop.state !== 'passed',
    );
  let previous = -1;
  const before = next < 0 ? list.length : next;
  for (let i = before - 1; i >= 0; i--) {
    if (callingStop(list[i]) && list[i].state === 'passed') {
      previous = i;
      break;
    }
  }
  return { previous, next };
}

/**
 * Choose what to draw for a trip: at most four labelled stops (previous,
 * next, after-next, terminus) among those the train calls at, and a dot for
 * every other placed stop (skipped and run-through stops too: the line passes
 * them).
 * @param {object[]} stops In trip order.
 * @returns {{labels: {stop: object, index: number, role: string,
 *   priority: number}[], dots: {stop: object, index: number, passed: boolean}[]}}
 */
export function selectStopLabels(stops) {
  const list = Array.isArray(stops) ? stops : [];
  const { previous, next } = stopRoleIndices(list);
  const chosen = new Map();
  const take = (index, role) => {
    if (index < 0 || index >= list.length || chosen.has(index)) return;
    if (!callingStop(list[index])) return;
    chosen.set(index, role);
  };
  take(next, 'next');
  take(previous, 'previous');
  if (next >= 0) {
    let after = next + 1;
    while (after < list.length && !callingStop(list[after])) after++;
    take(after, 'afterNext');
  }
  let last = list.length - 1;
  while (last >= 0 && !callingStop(list[last])) last--;
  // The terminus is worth a label while the train still has it ahead.
  if (last >= 0 && list[last].state !== 'passed') take(last, 'terminus');
  const labels = [...chosen]
    .map(([index, role]) => ({
      stop: list[index],
      index,
      role,
      priority: ROLE_PRIORITY[role],
    }))
    .sort((a, b) => a.index - b.index);
  const dots = [];
  for (let i = 0; i < list.length; i++) {
    if (chosen.has(i) || !placedStop(list[i])) continue;
    dots.push({ stop: list[i], index: i, passed: list[i].state === 'passed' });
  }
  return { labels, dots };
}

/**
 * The text a stop label carries: the name, then the clock and the relative
 * time, as `Yonkers · 14:32 T−4` once the host joins title and detail.
 * @param {object} stop
 * @returns {{title: string, detail: string}}
 */
export function stopLabelText(stop) {
  const time = [stopClock(stop), stop?.relative]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ');
  return { title: stopName(stop), detail: time };
}

/**
 * Shared-host entries for the chosen labels. Their time chip (the accent the
 * host paints beside the text and along the leader) is coloured by delay.
 * @param {string} trainKey The selected train, so ids change with it.
 * @param {ReturnType<typeof selectStopLabels>['labels']} labels
 * @param {(stop: object) => object|null} anchorFor Cartesian for a stop.
 * @returns {object[]}
 */
export function createStopOverlayEntries(trainKey, labels, anchorFor) {
  const entries = [];
  for (const label of labels || []) {
    const position = anchorFor(label.stop);
    if (!position) continue;
    const { title, detail } = stopLabelText(label.stop);
    entries.push({
      id: `${trainKey}:${label.index}:${label.stop.stopId ?? label.stop.name}`,
      variant: 'track',
      title,
      details: detail ? [detail] : [],
      accent: stopChipColor(stopDelayMs(label.stop)),
      priority: STOP_LABEL_BASE_PRIORITY + label.priority,
      collisionGroup: 'ambient-label',
      // The selected train's card is in the card domain; labels fit around it.
      yieldToCollisionGroup: 'ambient-card',
      paintLane: 'ambient-track',
      position,
      gapPx: 10,
      verticalOnly: true,
      placement: 'above',
      horizonCull: true,
      edgeFade: 'keyhole',
      interactive: false,
      metadata: { role: label.role },
    });
  }
  return entries;
}
