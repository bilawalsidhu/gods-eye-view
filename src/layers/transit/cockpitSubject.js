import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import { transitRouteLabel } from '../../data/transitFeeds.js';
import { displayMotion } from './movement.js';

/**
 * Read access to one vehicle, and a hold on it for a first-person view.
 *
 * `getSelectedVehicle()` and `getCockpitSubject()` describe the selected
 * vehicle and the held one as a frozen snapshot, read again on each call:
 * where it is drawn, how fast it moves and how that is known. Transit has no
 * route shapes or stops, so a snapshot names only the vehicle's last reported
 * stop. `setCockpitSubject(key)` holds a vehicle: its sprite, card, trail
 * and detection box are hidden, it keeps moving when it is out of the
 * camera's view, its feed stays polled, and clicks and Escape no longer
 * change the selection. The hold ends with `setCockpitSubject(null)`, and on
 * its own when the vehicle is removed or the layer is turned off.
 * `focusVehicle(key)` selects a vehicle, as a click does.
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

  function feedOf(feedId) {
    const feed =
      state._activeFeeds.get(feedId) || getRegisteredTransitFeed(feedId);
    if (!feed) return null;
    return Object.freeze({
      id: feed.id,
      name: feed.name ?? null,
      operator: feed.operator ?? null,
      region: feed.region ?? null,
      attribution: feed.attribution ?? null,
      license: feed.license ?? null,
      licenseUrl: feed.licenseUrl ?? null,
    });
  }

  /** The vehicle as a frozen snapshot (see the module comment), or null. */
  function vehicleView(entry) {
    if (!entry?.record) return null;
    const record = entry.record;
    const sample = entry.sample ?? null;
    const feed =
      state._activeFeeds.get(entry.feedId) ||
      getRegisteredTransitFeed(entry.feedId);
    const reported = finiteOrNull(record.speedMps);
    const derived = finiteOrNull(sample?.segmentSpeedMps);
    const status = state._feedStatus.get(entry.feedId);
    const latitude = finiteOrNull(sample?.lat) ?? record.lat;
    const longitude = finiteOrNull(sample?.lon) ?? record.lon;
    return Object.freeze({
      key: entry.key,
      feedId: entry.feedId,
      id: String(record.id ?? ''),
      routeId: record.routeId || null,
      routeLabel:
        (feed && record.routeId
          ? transitRouteLabel(feed, record.routeId)
          : null) || null,
      tripId: record.tripId || null,
      directionId: record.directionId ?? null,
      label: record.label || null,
      mode: entry.mode ?? null,
      modeInferred: entry.modeInferred === true,
      feed: feedOf(entry.feedId),
      position: Object.freeze({
        latitude,
        longitude,
        groundHeightM: Number.isFinite(entry.heightM)
          ? entry.heightM - liftM
          : null,
        atMs: finiteOrNull(sample?.displayT),
      }),
      motion: Object.freeze({
        reportedSpeedMps: reported,
        derivedSpeedMps: derived,
        speedSource:
          reported !== null ? 'reported' : derived !== null ? 'derived' : null,
        courseDeg: finiteOrNull(entry.courseDeg),
        reportedBearingDeg: finiteOrNull(record.bearing),
        segmentCourseDeg: finiteOrNull(sample?.segmentCourseDeg),
        phase: sample?.phase ?? null,
        word: displayMotion(entry, Date.now()).word,
        reportAgeMs: finiteOrNull(sample?.latestReportAgeMs),
        shownBehindMs: finiteOrNull(sample?.actualDelayMs),
        feedStale: status?.stale === true,
      }),
      stop: Object.freeze({
        stopId: record.stopId || null,
        status: record.status || null,
      }),
      provenance: Object.freeze({
        positionSource: 'gps',
        timestampSource: record.timestampSource ?? null,
      }),
    });
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
      parts.selection.selectVehicle(key);
      return true;
    },
  };
  return { methods, vehicleView };
}
