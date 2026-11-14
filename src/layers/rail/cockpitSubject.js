import { pointAtS } from '../../data/railPaths.js';
import { getRegisteredRailFeed } from '../../data/railFeeds.js';
import { displayMotion } from '../transit/movement.js';

/** Each line's read-only copy for a snapshot's `path.line` (lineOf). */
const lines = new WeakMap();

/**
 * A line as a snapshot hands it out: a frozen copy of the layer's path, its
 * number arrays frozen arrays, built once per line. `pointAtS` and
 * `projectOnPath` read it as they read the path, and nothing written to it
 * reaches the layer.
 */
function lineOf(path) {
  let line = lines.get(path);
  if (!line) {
    const copy = {};
    for (const [name, value] of Object.entries(path))
      copy[name] = ArrayBuffer.isView(value)
        ? Object.freeze(Array.from(value))
        : value;
    line = Object.freeze(copy);
    lines.set(path, line);
  }
  return line;
}

const NO_STOPS = Object.freeze([]);
/** Each stops list's frozen copy for a snapshot's `stops` (stopsOf). */
const stopLists = new WeakMap();

/** Whether `copy` still holds each of `list`'s stops, field by field. */
function sameStops(copy, list) {
  if (copy.length !== list.length) return false;
  for (let i = 0; i < list.length; i++) {
    const stop = list[i];
    const kept = copy[i];
    if (
      !stop ||
      typeof stop !== 'object' ||
      !kept ||
      typeof kept !== 'object'
    ) {
      if (!Object.is(stop, kept)) return false;
      continue;
    }
    const names = Object.keys(stop);
    if (names.length !== Object.keys(kept).length) return false;
    for (const name of names)
      if (!Object.is(stop[name], kept[name])) return false;
  }
  return true;
}

/**
 * A trip's stops as a snapshot hands them out: a frozen array of frozen
 * copies, kept per list the stops provider returns while that list still
 * holds the same stops, so a provider that updates its list in place is
 * copied again.
 */
function stopsOf(list) {
  if (!Array.isArray(list)) return NO_STOPS;
  let stops = stopLists.get(list);
  if (!stops || !sameStops(stops, list)) {
    stops = Object.freeze(
      list.map((stop) =>
        stop && typeof stop === 'object' ? Object.freeze({ ...stop }) : stop,
      ),
    );
    stopLists.set(list, stops);
  }
  return stops;
}

/**
 * `previous` when it holds each of `next`'s values, else a frozen copy of
 * `next`: a part of a snapshot that did not change is the one read before.
 * `next` is a draft, filled again on every read.
 */
function reuse(previous, next) {
  if (!previous) return Object.freeze({ ...next });
  for (const name in next)
    if (!Object.is(previous[name], next[name]))
      return Object.freeze({ ...next });
  return previous;
}

/**
 * Read access to one train, and a hold on it for a first-person view.
 *
 * `getSelectedTrain()` and `getCockpitSubject()` describe the selected train
 * and the held one as a frozen snapshot, read again on each call: where it is
 * along its line, how fast it moves and how that is known, and its stops. A
 * call while nothing in it changed returns the snapshot it returned before,
 * and a part that did not change (its feed, its line, its stops) is the same
 * object in the next one, so a view can read it on every frame. `path.line`
 * is a frozen copy of the train's line for `pointAtS` and `projectOnPath`.
 * `setCockpitSubject(key)` holds a train: its marker, 3D model, card and
 * selected line are hidden, it stays selected (so its stops stay fresh and its feed stays
 * polled at any distance) and clicks and Escape no longer change the
 * selection. A held train keeps moving, hidden, and keeps the selection when
 * its category is turned off, and is the copy of its train drawn though
 * another feed's copy would outrank it (dedupe.js). Released, it is a train
 * like any other: one in a category turned off is deselected and stops, and
 * a better copy takes over at the next poll. The hold ends with
 * `setCockpitSubject(null)`, and on its own when the train is removed or the
 * layer is turned off. A train removed while held leaves its feed polled
 * until the next `setCockpitSubject` call, so a view that waits for it holds
 * it again if the feed lists it again.
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
  /** Each train's last snapshot, returned again while nothing in it changed. */
  const views = new WeakMap();
  /** The drafts trainView fills on every read (reuse). */
  const draft = {
    view: {},
    feed: {},
    position: {},
    path: {},
    motion: {},
    provenance: {},
  };

  /** The catalog's public entry for a feed, else the registry's. */
  function feedOf(feedId, previous) {
    const listed = state._catalog?.find((feed) => feed.id === feedId);
    const feed = listed ?? getRegisteredRailFeed(feedId);
    if (!feed) return null;
    const next = draft.feed;
    next.id = feed.id;
    next.name = feed.name ?? null;
    next.operator = feed.operator ?? null;
    next.region = feed.region ?? null;
    next.positions = listed?.positions ?? feed.positions ?? 'gps';
    next.tripUpdates =
      typeof listed?.tripUpdates === 'boolean'
        ? listed.tripUpdates
        : typeof feed.tripUpdatesUrl === 'string';
    next.attribution = feed.attribution ?? null;
    next.license = feed.license ?? null;
    next.licenseUrl = feed.licenseUrl ?? null;
    return reuse(previous, next);
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
    const previous = views.get(entry);
    const record = entry.record;
    const sample = entry.sample ?? null;
    const drawn = entry.drawnHeight ?? null;
    const binding = entry.path ?? null;
    const reported = finiteOrNull(record.speedMps);
    const derived = finiteOrNull(sample?.segmentSpeedMps);
    const trip = state._selectedKey === entry.key ? state._trip : null;
    const status = state._feedStatus.get(entry.feedId);

    const position = draft.position;
    position.latitude =
      finiteOrNull(drawn?.lat) ?? finiteOrNull(sample?.lat) ?? record.lat;
    position.longitude =
      finiteOrNull(drawn?.lon) ?? finiteOrNull(sample?.lon) ?? record.lon;
    position.railHeightM = Number.isFinite(drawn?.h) ? drawn.h - liftM : null;
    position.heightQuality = Number.isFinite(drawn?.q) ? drawn.q : 0;
    position.atMs = finiteOrNull(drawn?.at);

    let path = null;
    if (binding && binding.path) {
      path = draft.path;
      path.shapeIndex = binding.shapeIndex;
      path.s = binding.drawS;
      path.direction = directionOf(entry);
      path.lengthM = binding.path.length;
      path.via = binding.via;
      path.builtAt = state._pathPacks.get(entry.feedId)?.pack?.builtAt ?? null;
      path.line = lineOf(binding.path);
    }

    const motion = draft.motion;
    motion.reportedSpeedMps = reported;
    motion.derivedSpeedMps = derived;
    motion.speedSource =
      reported !== null ? 'reported' : derived !== null ? 'derived' : null;
    motion.courseDeg = finiteOrNull(entry.courseDeg);
    motion.phase = sample?.phase ?? null;
    motion.word = displayMotion(entry, Date.now()).word;
    motion.reportAgeMs = finiteOrNull(sample?.latestReportAgeMs);
    motion.shownBehindMs = finiteOrNull(sample?.actualDelayMs);
    motion.feedStale = status?.stale === true;

    const provenance = draft.provenance;
    provenance.positionSource = record.positionSource ?? 'gps';
    provenance.timestampSource = record.timestampSource ?? null;

    const view = draft.view;
    view.key = entry.key;
    view.feedId = entry.feedId;
    view.selectedAtMs =
      state._selectedKey === entry.key ? state._selectedAtMs : null;
    view.id = String(record.id ?? '');
    view.tripId = record.tripId || null;
    view.routeId = record.routeId || null;
    view.routeName = routeNameOf(entry);
    view.label = record.label || null;
    view.trainNumber = record.trainNumber || null;
    view.headsign = trip?.headsign || null;
    view.category = entry.category ?? null;
    view.mode = entry.railMode ?? null;
    view.feed = feedOf(entry.feedId, previous?.feed);
    view.position = reuse(previous?.position, position);
    view.path = path && reuse(previous?.path, path);
    view.motion = reuse(previous?.motion, motion);
    view.provenance = reuse(previous?.provenance, provenance);
    view.stops = stopsOf(trip?.stops);
    view.match = trip?.match ?? null;
    const snapshot = reuse(previous, view);
    views.set(entry, snapshot);
    return snapshot;
  }

  /** A train's marker and playback again, after a hold on it began or ended. */
  function replay(entry) {
    parts.rendering.paint(entry);
    parts.rendering.schedulePlayback(entry);
    parts.rendering.syncRenderHold();
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
     * @returns {boolean} False for a key the layer does not list. A listed
     *   train is held even when its category is off or another feed's copy
     *   is drawn: the held copy is then the one drawn. Releasing returns true.
     */
    setCockpitSubject(key) {
      const previous = state._trains.get(state._cockpitSubjectKey);
      if (key === null || key === undefined) {
        state._cockpitSubjectKey = null;
        state._cockpitLostFeedId = null;
        if (previous) {
          // Its category turned off meanwhile: deselected, as the toggle
          // does to any other train (controls.js).
          if (
            previous.key === state._selectedKey &&
            state._categories[previous.category] === false
          )
            parts.selection.clearSelection();
          replay(previous);
        }
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
      // Another feed's copy drew it: the held copy is drawn now (dedupe.js).
      if (entry.duplicate === true) parts.ingestion.duplicates?.refresh();
      if (previous && previous !== entry) replay(previous);
      replay(entry);
      parts.selection.refreshSelectedCard(true);
      parts.routes.applyHold?.();
      return true;
    },
    /**
     * Select the train `key` and hand it the camera, as a click on it does.
     * @param {string} key
     * @returns {boolean} False for a train the layer does not show: gone, in
     *   a category turned off, or a copy another feed draws (dedupe.js).
     */
    focusTrain(key) {
      const entry = state._trains.get(key);
      if (!entry || !parts.rendering.categoryShown(entry)) return false;
      parts.selection.selectAndFocusTrain(key);
      return true;
    },
  };
  return { methods, trainView };
}
