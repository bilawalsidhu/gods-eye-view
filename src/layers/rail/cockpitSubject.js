import { pointAtS } from '../../data/railPaths.js';
import { getRegisteredRailFeed } from '../../data/railFeeds.js';
import { displayMotion } from '../transit/movement.js';

/**
 * Read access to one train, and a hold on it for a first-person view.
 *
 * `getSelectedTrain()` and `getCockpitSubject()` describe the selected train
 * and the held one as a frozen snapshot, read again on each call: where it is
 * along its line, how fast it moves and how that is known, and its stops.
 * `setCockpitSubject(key)` holds a train: its marker, card and selected line
 * are hidden, it stays selected (so its stops stay fresh and its feed stays
 * polled at any distance) and clicks and Escape no longer change the
 * selection. The hold ends with `setCockpitSubject(null)`, and on its own
 * when the train is removed or the layer is turned off. A train removed while
 * held leaves its feed polled until the next `setCockpitSubject` call, so a
 * view that waits for it holds it again if the feed lists it again.
 * `focusTrain(key)` selects a train and hands it the camera, as a click does.
 * A snapshot's `selectedAtMs` is when the user last selected the selected
 * train (a click, or `focusTrain`), even again, for a view's entry to tell a
 * re-selection. It is null for any other train, after a deselection, and for
 * a train selected only by a hold: a hold is not a user's selection.
 *
 * @param {object} context The layer's state, parts, services and timetable.
 * @returns {{methods: object}}
 */
export function createRailCockpitSubject({
  state,
  parts,
  services,
  timetable,
}) {
  const liftM = Number.isFinite(services.ground?.GROUND_FLOOR_LIFT_M)
    ? services.ground.GROUND_FLOOR_LIFT_M
    : 0;
  const finiteOrNull = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const scratch = {};

  /** The catalog's public entry for a feed, else the registry's. */
  function feedOf(feedId) {
    const listed = state._catalog?.find((feed) => feed.id === feedId);
    const feed = listed ?? getRegisteredRailFeed(feedId);
    if (!feed) return null;
    return Object.freeze({
      id: feed.id,
      name: feed.name ?? null,
      operator: feed.operator ?? null,
      region: feed.region ?? null,
      positions: listed?.positions ?? feed.positions ?? 'gps',
      tripUpdates:
        typeof listed?.tripUpdates === 'boolean'
          ? listed.tripUpdates
          : typeof feed.tripUpdatesUrl === 'string',
      attribution: feed.attribution ?? null,
      license: feed.license ?? null,
      licenseUrl: feed.licenseUrl ?? null,
    });
  }

  /** The route's short (else long) name in the feed's timetable, or null. */
  function routeNameOf(entry) {
    const routeId = entry.record?.routeId;
    if (!routeId) return null;
    const schedule = timetable?.scheduleFor?.(entry.feedId);
    const route = schedule?.routes?.[routeId];
    const name = route?.short || route?.long;
    return typeof name === 'string' && name ? name : null;
  }

  /**
   * Which way the train runs along its shape: as its binding learnt it from
   * successive reports, else from its drawn course against the line's
   * bearing there; 0 while neither tells.
   */
  function directionOf(entry) {
    const binding = entry.path;
    if (binding.direction === 1 || binding.direction === -1)
      return binding.direction;
    const course = finiteOrNull(entry.courseDeg);
    const point = pointAtS(binding.path, binding.drawS, scratch);
    if (course === null || !Number.isFinite(point?.bearingDeg)) return 0;
    const turn = Math.abs(((course - point.bearingDeg + 540) % 360) - 180);
    return turn > 90 ? -1 : 1;
  }

  /** The train as a frozen snapshot (see the module comment), or null. */
  function trainView(entry) {
    if (!entry?.record) return null;
    const record = entry.record;
    const sample = entry.sample ?? null;
    const drawn = entry.drawnHeight ?? null;
    const binding = entry.path ?? null;
    const reported = finiteOrNull(record.speedMps);
    const derived = finiteOrNull(sample?.segmentSpeedMps);
    const trip = state._selectedKey === entry.key ? state._trip : null;
    const status = state._feedStatus.get(entry.feedId);
    const latitude =
      finiteOrNull(drawn?.lat) ?? finiteOrNull(sample?.lat) ?? record.lat;
    const longitude =
      finiteOrNull(drawn?.lon) ?? finiteOrNull(sample?.lon) ?? record.lon;
    return Object.freeze({
      key: entry.key,
      feedId: entry.feedId,
      selectedAtMs:
        state._selectedKey === entry.key ? state._selectedAtMs : null,
      id: String(record.id ?? ''),
      tripId: record.tripId || null,
      routeId: record.routeId || null,
      routeName: routeNameOf(entry),
      label: record.label || null,
      trainNumber: record.trainNumber || null,
      headsign: trip?.headsign || null,
      category: entry.category ?? null,
      mode: entry.railMode ?? null,
      feed: feedOf(entry.feedId),
      position: Object.freeze({
        latitude,
        longitude,
        railHeightM: Number.isFinite(drawn?.h) ? drawn.h - liftM : null,
        heightQuality: Number.isFinite(drawn?.q) ? drawn.q : 0,
        atMs: finiteOrNull(drawn?.at),
      }),
      path:
        binding && binding.path
          ? Object.freeze({
              shapeIndex: binding.shapeIndex,
              s: binding.drawS,
              direction: directionOf(entry),
              lengthM: binding.path.length,
              via: binding.via,
              builtAt:
                state._pathPacks.get(entry.feedId)?.pack?.builtAt ?? null,
              line: binding.path,
            })
          : null,
      motion: Object.freeze({
        reportedSpeedMps: reported,
        derivedSpeedMps: derived,
        speedSource:
          reported !== null ? 'reported' : derived !== null ? 'derived' : null,
        courseDeg: finiteOrNull(entry.courseDeg),
        phase: sample?.phase ?? null,
        word: displayMotion(entry, Date.now()).word,
        reportAgeMs: finiteOrNull(sample?.latestReportAgeMs),
        shownBehindMs: finiteOrNull(sample?.actualDelayMs),
        feedStale: status?.stale === true,
      }),
      provenance: Object.freeze({
        positionSource: record.positionSource ?? 'gps',
        timestampSource: record.timestampSource ?? null,
      }),
      stops: Object.freeze(Array.isArray(trip?.stops) ? [...trip.stops] : []),
      match: trip?.match ?? null,
    });
  }

  const methods = {
    /** The selected train (see createRailCockpitSubject), or null. */
    getSelectedTrain() {
      return trainView(state._trains.get(state._selectedKey));
    },
    /** The held train, or null when none is held. */
    getCockpitSubject() {
      return trainView(state._trains.get(state._cockpitSubjectKey));
    },
    /**
     * Hold the train `key` for a first-person view, or release the hold with
     * null. A train it holds is selected, if it was not already.
     * @param {string|null} key
     * @returns {boolean} False for a train the layer does not show.
     */
    setCockpitSubject(key) {
      const previous = state._trains.get(state._cockpitSubjectKey);
      if (key === null || key === undefined) {
        state._cockpitSubjectKey = null;
        state._cockpitLostFeedId = null;
        if (previous) parts.rendering.paint(previous);
        parts.selection.refreshSelectedCard(true);
        parts.routes.applyHold?.();
        return true;
      }
      const entry = state._trains.get(key);
      if (!entry) return false;
      if (state._selectedKey !== key) {
        parts.selection.selectTrain(key);
        // A hold is not a selection the user made (selectedAtMs).
        state._selectedAtMs = null;
      }
      state._cockpitSubjectKey = key;
      state._cockpitLostFeedId = null;
      if (previous && previous !== entry) parts.rendering.paint(previous);
      parts.rendering.paint(entry);
      parts.selection.refreshSelectedCard(true);
      parts.routes.applyHold?.();
      return true;
    },
    /**
     * Select the train `key` and hand it the camera, as a click on it does.
     * @param {string} key
     * @returns {boolean} False for a train the layer does not show.
     */
    focusTrain(key) {
      if (!state._trains.has(key)) return false;
      parts.selection.selectAndFocusTrain(key);
      return true;
    },
  };
  return { methods, trainView };
}
