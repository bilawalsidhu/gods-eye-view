import {
  getRegisteredTransitFeed,
  transitRouteLabel,
} from '../../data/transitFeeds.js';
import { displayMotion } from './movement.js';

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
 * Read access to one vehicle, and a hold on it for a first-person view.
 *
 * `getSelectedVehicle()` and `getCockpitSubject()` describe the selected
 * vehicle and the held one as a frozen snapshot, read again on each call:
 * where it is drawn, how fast it moves and how that is known. A call while
 * nothing in it changed returns the snapshot it returned before, and a part
 * that did not change (its feed, its stop) is the same object in the next
 * one, so a view can read it on every frame. Transit has no route shapes or
 * stops, so a snapshot names only the vehicle's last reported stop.
 * `setCockpitSubject(key)` holds a vehicle: its sprite, card, trail and
 * detection box are hidden, it keeps moving when it is out of the camera's
 * view, its feed stays polled, and clicks and Escape no longer change the
 * selection. The hold ends with `setCockpitSubject(null)`, and on
 * its own when the vehicle is removed or the layer is turned off.
 * `focusVehicle(key)` selects a vehicle, as a click does. A snapshot's
 * `selectedAtMs` is when the user last selected the selected vehicle (a
 * click, or `focusVehicle`), even again. It is null for any other vehicle,
 * after a deselection, and for a vehicle selected only by a hold: a hold is
 * not a user's selection.
 *
 * @param {object} context The layer's state, parts and services.
 * @returns {{methods: object}}
 */
export function createTransitCockpitSubject({ state, parts, services }) {
  const liftM = Number.isFinite(services.ground?.GROUND_FLOOR_LIFT_M)
    ? services.ground.GROUND_FLOOR_LIFT_M
    : 0;
  const finiteOrNull = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  /** Each vehicle's last snapshot, returned again while nothing changed. */
  const views = new WeakMap();
  /** The drafts vehicleView fills on every read (reuse). */
  const draft = {
    view: {},
    feed: {},
    position: {},
    motion: {},
    stop: {},
    provenance: {},
  };

  /** The feed in use, else the registry's entry for it. */
  function feedEntry(feedId) {
    return state._activeFeeds.get(feedId) || getRegisteredTransitFeed(feedId);
  }

  function feedOf(feed, previous) {
    if (!feed) return null;
    const next = draft.feed;
    next.id = feed.id;
    next.name = feed.name ?? null;
    next.operator = feed.operator ?? null;
    next.region = feed.region ?? null;
    next.attribution = feed.attribution ?? null;
    next.license = feed.license ?? null;
    next.licenseUrl = feed.licenseUrl ?? null;
    return reuse(previous, next);
  }

  /** The vehicle as a frozen snapshot (see the module comment), or null. */
  function vehicleView(entry) {
    if (!entry?.record) return null;
    const previous = views.get(entry);
    const record = entry.record;
    const sample = entry.sample ?? null;
    const feed = feedEntry(entry.feedId);
    const reported = finiteOrNull(record.speedMps);
    const derived = finiteOrNull(sample?.segmentSpeedMps);
    const status = state._feedStatus.get(entry.feedId);

    const position = draft.position;
    position.latitude = finiteOrNull(sample?.lat) ?? record.lat;
    position.longitude = finiteOrNull(sample?.lon) ?? record.lon;
    position.groundHeightM = Number.isFinite(entry.heightM)
      ? entry.heightM - liftM
      : null;
    position.atMs = finiteOrNull(sample?.displayT);

    const motion = draft.motion;
    motion.reportedSpeedMps = reported;
    motion.derivedSpeedMps = derived;
    motion.speedSource =
      reported !== null ? 'reported' : derived !== null ? 'derived' : null;
    motion.courseDeg = finiteOrNull(entry.courseDeg);
    motion.reportedBearingDeg = finiteOrNull(record.bearing);
    motion.segmentCourseDeg = finiteOrNull(sample?.segmentCourseDeg);
    motion.phase = sample?.phase ?? null;
    motion.word = displayMotion(entry, Date.now()).word;
    motion.reportAgeMs = finiteOrNull(sample?.latestReportAgeMs);
    motion.shownBehindMs = finiteOrNull(sample?.actualDelayMs);
    motion.feedStale = status?.stale === true;

    const stop = draft.stop;
    stop.stopId = record.stopId || null;
    stop.status = record.status || null;

    const provenance = draft.provenance;
    provenance.positionSource = 'gps';
    provenance.timestampSource = record.timestampSource ?? null;

    const view = draft.view;
    view.key = entry.key;
    view.feedId = entry.feedId;
    view.selectedAtMs =
      state._selectedKey === entry.key ? state._selectedAtMs : null;
    view.id = String(record.id ?? '');
    view.routeId = record.routeId || null;
    view.routeLabel =
      (feed && record.routeId
        ? transitRouteLabel(feed, record.routeId)
        : null) || null;
    view.tripId = record.tripId || null;
    view.directionId = record.directionId ?? null;
    view.label = record.label || null;
    view.mode = entry.mode ?? null;
    view.modeInferred = entry.modeInferred === true;
    view.feed = feedOf(feed, previous?.feed);
    view.position = reuse(previous?.position, position);
    view.motion = reuse(previous?.motion, motion);
    view.stop = reuse(previous?.stop, stop);
    view.provenance = reuse(previous?.provenance, provenance);
    const snapshot = reuse(previous, view);
    views.set(entry, snapshot);
    return snapshot;
  }

  /** Show or hide a vehicle's sprite and trail for the hold. */
  function repaint(entry) {
    if (!entry?.marker) return;
    if (entry.key === state._cockpitSubjectKey) entry.marker.show = false;
    else parts.rendering.placeSample(entry);
    parts.rendering.schedulePlayback(entry);
    parts.trails.update();
    state._detectRevision += 1;
  }

  const methods = {
    /** The selected vehicle (see createTransitCockpitSubject), or null. */
    getSelectedVehicle() {
      return vehicleView(state._vehicles.get(state._selectedKey));
    },
    /** The held vehicle, or null when none is held. */
    getCockpitSubject() {
      return vehicleView(state._vehicles.get(state._cockpitSubjectKey));
    },
    /**
     * Hold the vehicle `key` for a first-person view, or release the hold
     * with null. A vehicle it holds is selected, if it was not already.
     * @param {string|null} key
     * @returns {boolean} False for a vehicle the layer does not show.
     */
    setCockpitSubject(key) {
      const previous = state._vehicles.get(state._cockpitSubjectKey);
      if (key === null || key === undefined) {
        state._cockpitSubjectKey = null;
        // The hold kept it in play out of view: it leaves until the next
        // visibility sweep finds it in view again.
        if (previous) {
          state._visible.delete(previous);
          parts.rendering.requestVisibility();
        }
        repaint(previous);
        parts.selection.refreshSelectedCard(true);
        return true;
      }
      const entry = state._vehicles.get(key);
      if (!entry?.marker) return false;
      if (state._selectedKey !== key) parts.selection.selectVehicle(key);
      state._cockpitSubjectKey = key;
      state._visible.add(entry);
      if (previous && previous !== entry) repaint(previous);
      repaint(entry);
      parts.selection.refreshSelectedCard(true);
      return true;
    },
    /**
     * Select the vehicle `key`, as a click on it does.
     * @param {string} key
     * @returns {boolean} False for a vehicle the layer does not show.
     */
    focusVehicle(key) {
      if (!state._vehicles.get(key)?.marker) return false;
      parts.selection.selectVehicle(key, { byUser: true });
      return true;
    },
  };
  return { methods, vehicleView };
}
