import {
  ACTIVATION_ALTITUDE_M,
  FEED_STALE_AFTER_MS,
  aggregateTransitFeedHealth,
  transitDetectionClass,
  transitDetectionId,
  transitDetectionMetric,
} from './policy.js';
import {
  TRANSIT_ENABLED_FEEDS,
  getRegisteredTransitFeed,
} from '../../data/transitFeeds.js';
import { transitModeTier } from '../../data/transitPresetStyle.js';
import { t, tn } from '../../i18n/index.js';
import {
  TRANSIT_STATION_DESCRIPTION,
  transitStationSegments,
} from './stationModel.js';

/**
 * The row's count, split into the two populations the row draws.
 *
 * The Transit row shows live GTFS-RT vehicles AND the static SNCF station
 * network. One number for both would read as a count of trains, so the two
 * are named separately: "12 vehicles · 2792 stations".
 *
 * A population that is absent is NOT shown as a zero: a layer that has the
 * stations but no live vehicles yet reads "2792 stations", not "0 vehicles ·
 * 2792 stations". When neither is loaded the label is empty, which is the
 * panel's own way of saying there is nothing to count.
 *
 * @param {number} vehicles The live vehicle count.
 * @param {number} stations The mapped station count.
 * @returns {string} The count label, or '' when there is nothing to count.
 */
export function transitCountLabel(vehicles, stations) {
  const hasVehicles = Number.isFinite(vehicles) && vehicles > 0;
  const hasStations = Number.isFinite(stations) && stations > 0;
  if (hasVehicles && hasStations)
    return t('{vehicles} vehicles · {stations} stations', {
      vehicles: String(vehicles),
      stations: String(stations),
    });
  if (hasVehicles) return t('{count} vehicles', { count: String(vehicles) });
  if (hasStations) return t('{count} stations', { count: String(stations) });
  return '';
}

/**
 * The registry entry behind a vehicle. Live feeds answer first so a feed the
 * session disabled stops supplying vocabulary; the registry is the fallback,
 * because a vehicle can outlive the poll that brought it.
 * @param {object} state Layer state.
 * @param {object} entry Vehicle entry.
 * @returns {object|null}
 */
function feedForEntry(state, entry) {
  const id = entry?.feedId;
  if (!id) return null;
  return state._activeFeeds.get(id) || getRegisteredTransitFeed(id) || null;
}

/**
 * The layer row's answer to "what is on screen and is it honest?".
 * @param {object} context
 * @returns {object}
 */
export function createQueries({ state, parts }) {
  const empty = [];
  const defaults = {};
  let requestedMax = Infinity,
    requestedSeed = 0;
  /**
   * A stable 32-bit hash of a vehicle key, mixed with the caller's seed.
   *
   * Selection has to survive ordinary churn. Striding by position in the map
   * meant that one bus leaving at the front renumbered every bus behind it, so
   * a single removal swapped the whole labelled set for its neighbours —
   * visible as every callout jumping one vehicle sideways. A hash of the key
   * belongs to the vehicle, not to its place in a list, so a removal anywhere
   * leaves every other vehicle's standing untouched.
   *
   * @param {string} key
   * @param {number} seed
   * @returns {number} Unsigned 32-bit.
   */
  function selectionRank(key, seed) {
    // FNV-1a, seeded. Cheap, no allocation, and well spread for short ids.
    let hash = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  /**
   * The vehicles the detection overlay may box and label this frame.
   *
   * Detection PULLS this on every paint, not only on label solves, so it must
   * not be a fleet scan: the answer is CACHED and rebuilt only when something
   * that could change it has happened — a poll, a visibility sweep, a
   * removal, a selection — which the rest of the layer signals by bumping
   * `state._detectRevision`. Between those, every paint gets the same array
   * back. Positions inside it are the markers' own Cartesians, which the frame
   * pass writes in place, so they are live without a copy; only the motion
   * word is re-read per paint, and only for the entries actually handed over.
   *
   * Two older rules stand. Visibility is applied FIRST: sampling the whole
   * fleet and then discarding the hidden ones meant a single visible bus in a
   * fleet of five thousand could fall outside the sample and go unlabelled
   * while the overlay had thousands of slots free. And selection among the
   * visible is by hash, not by position, so the labelled set is stable as
   * vehicles come and go. The selected vehicle is handed over with
   * `skipLabel` — it has its own fuller card.
   *
   * @param {{maxCount?: number, seed?: number}} [options]
   * @returns {Array<object>}
   */
  function collectDetectableVehicles(options = defaults) {
    if (!state._enabled || !state._markers?.show) return empty;
    if (state._vehicles.size === 0) return empty;
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : Infinity;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;

    requestedMax = maxCount;
    requestedSeed = seed;
    if (!state._detectCache) refreshDetectCache();
    return state._detectCache?.contacts || empty;
  }
  function refreshDetectCache() {
    if (!state._enabled) return;
    const cache = state._detectCache;
    const now = Date.now();
    const maxCount = requestedMax,
      seed = requestedSeed;
    if (now - state._detectBuiltAt < 250) return;
    state._detectBuiltAt = now;
    if (
      cache &&
      cache.revision === state._detectRevision &&
      cache.maxCount === maxCount &&
      cache.seed === seed
    ) {
      for (const contact of cache.contacts)
        contact.metric = transitDetectionMetric(
          contact._entry,
          contact._entry.mode,
          now,
          feedForEntry(state, contact._entry),
        );
      return;
    }
    if (cache)
      for (const contact of cache.contacts) contact._entry.detectContact = null;
    const visible = [];
    for (const entry of state._visible) {
      const marker = entry.marker;
      if (!marker?.position || marker.show === false) continue;
      visible.push(entry);
    }
    let chosen = visible;
    if (visible.length > maxCount) {
      // Take the lowest-ranked keys. Removing an unselected vehicle cannot
      // change this set at all, and removing a selected one promotes exactly
      // one replacement instead of reshuffling everybody.
      chosen = visible
        .map((entry) => ({ entry, rank: selectionRank(entry.key, seed) }))
        .sort((a, b) => a.rank - b.rank || (a.entry.key < b.entry.key ? -1 : 1))
        .slice(0, maxCount)
        .map((scored) => scored.entry);
    }
    const contacts = [];
    for (const entry of chosen) {
      // Route and operator text change with the record and the mode, both of
      // which arrive on polls — the same events that rebuild this list.
      if (!entry.labelId || entry.labelRecord !== entry.record) {
        entry.labelId = transitDetectionId(
          entry.record,
          feedForEntry(state, entry),
        );
        entry.labelRecord = entry.record;
      }
      if (!entry.labelClass || entry.labelMode !== entry.mode) {
        entry.labelClass = transitDetectionClass(
          entry.mode,
          feedForEntry(state, entry),
        );
        entry.labelMode = entry.mode;
      }
      const contact = {
        position: entry.marker.position,
        bracketHalfWidth: Math.ceil(entry.marker.width / 2) + 2,
        bracketHalfHeight: Math.ceil(entry.marker.height / 2) + 2,
        sourceId: entry.key,
        id: entry.labelId,
        type: 'VEH',
        klass: entry.labelClass,
        metric: transitDetectionMetric(
          entry,
          entry.mode,
          now,
          feedForEntry(state, entry),
        ),
        // The bracket carries the mode colour in every preset: the detection
        // canvas sits above the post-FX chain, where the sprites' own colour
        // is lost under NVG and FLIR. Keyless too — the feeds are keyless.
        tier: transitModeTier(entry.mode),
        skipLabel: entry.key === state._selectedKey,
        _entry: entry,
      };
      entry.detectContact = contact;
      contacts.push(contact);
    }
    state._detectCache = {
      revision: state._detectRevision,
      maxCount,
      seed,
      contacts,
    };
    return contacts;
  }

  const methods = {
    /**
     * Detection contract: buses, trams and trains are contacts like any other.
     * @param {{maxCount?: number, seed?: number}} [options]
     * @returns {Array<object>}
     */
    getDetectableObjects(options = defaults) {
      return collectDetectableVehicles(options);
    },

    /**
     * Snapshot loaded transit vehicles (last reported fix) as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, label, routeId, mode, lat, lon, speedMps, courseDeg, status, occupancy}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!state._enabled) return [];
      const num = (v) => (Number.isFinite(v) ? v : null);
      const result = [];
      for (const entry of state._vehicles.values()) {
        if (result.length >= maxCount) break;
        const record = entry.record || {};
        if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
          continue;
        result.push({
          id: record.label || record.id || entry.key,
          label: record.label || null,
          routeId: record.routeId || null,
          mode: entry.mode || null,
          lat: record.lat,
          lon: record.lon,
          speedMps: num(record.speedMps),
          courseDeg: num(entry.courseDeg ?? record.bearing),
          status: record.status || null,
          occupancy: record.occupancy || null,
          // The station fields belong to the STATION network this same row
          // draws. A vehicle record carries them empty, so one declared
          // shape covers both halves of the merged layer.
          name: null,
          shortCode: null,
          uic: null,
          segment: null,
        });
      }
      // The French passenger-station network the same row draws. Its rows are
      // station records, not vehicle records, so they carry the station's own
      // fields rather than a vehicle's.
      for (const station of state._stations || []) {
        if (result.length >= maxCount) break;
        result.push({
          id: station.id,
          label: station.name,
          routeId: null,
          mode: 'station',
          lat: station.lat,
          lon: station.lon,
          speedMps: null,
          courseDeg: null,
          status: station.shortCode || null,
          occupancy: null,
          name: station.name,
          shortCode: station.shortCode,
          uic: station.uic,
          segment: station.segment,
        });
      }
      return result;
    },

    /**
     * The Transit row's own controls: chips that switch between the two
     * halves of the merged row, and a legend for the station network's rail
     * segments.
     *
     * The row draws the live GTFS-RT fleet AND the static SNCF passenger-
     * station network. The chips let the operator look at one or the other;
     * the legend names the rail segments the stations are coloured by, using
     * the very colours the map draws them in.
     *
     * The station network's own disclaimer stays on the row, so it is never
     * mistaken for live train telemetry: the SNCF catalogue publishes none.
     */
    getRowControls() {
      const stations = state._stations || [];
      const stationCount = stations.length;
      const vehicleCount = state._vehicles.size;
      const segments = transitStationSegments(stations);
      return {
        chips: [
          {
            id: 'vehicles',
            label: t('VEHICLES'),
            active: state._display !== 'stations',
            title: t(
              'Live GTFS-RT vehicle positions. These are the only live positions this row draws.',
            ),
            params: { display: 'vehicles' },
          },
          {
            id: 'stations',
            label: t('STATIONS'),
            active: state._display !== 'vehicles',
            title: t(
              'The static SNCF passenger-station network. This is a catalogue of station positions, not live train positions.',
            ),
            params: { display: 'stations' },
          },
          {
            id: 'both',
            label: t('BOTH'),
            active: state._display === 'both',
            title: t('Show the live fleet and the station network together'),
            params: { display: 'both' },
          },
        ],
        legend: segments.map((segment, index) => ({
          label: t(segment.label, { segment: t(segment.segmentLabel) }),
          color: segment.color,
          count: segment.count,
          ...(index === 0
            ? {
                blurb: t(
                  'Colour shows the station class: a principal station (the SNCF catalogue gives it a public short code) keeps its rail segment colour, and a local station (no short code) is drawn in the same segment colour muted. The stations are a static catalogue of positions, not live train positions.',
                ),
              }
            : {}),
        })),
        info: state._stationError
          ? t('Station network unavailable')
          : t('{vehicles} live · {stations} mapped', {
              vehicles: String(vehicleCount),
              stations: String(stationCount),
            }),
        infoTitle: t(TRANSIT_STATION_DESCRIPTION),
      };
    },

    getStats() {
      const active = [...state._activeFeeds.values()];
      const statuses = active.map((feed) =>
        parts.ingestion.feedStatus(feed.id),
      );
      const now = Date.now();
      const health = aggregateTransitFeedHealth(statuses, now);
      const count = state._vehicles.size;
      // The row counts what it DRAWS: the live fleet plus the French
      // passenger stations. The stations are static, so they are counted from
      // the catalogue rather than from a poll.
      const stationCount = (state._stations || []).length;
      const stationNote = stationCount ? ` · ${stationCount} stations` : '';
      if (state._enabled && active.length === 0) {
        return {
          count: stationCount,
          countLabel: transitCountLabel(0, stationCount),
          lastUpdate: state._lastUpdate,
          error: null,
          source: 'GTFS-RT · SNCF',
          status: 'zoom-in',
          // English data (the analyst's empty note to the model); the voice
          // card shows it through NOTE_PATTERNS (voice/resultDisplay.js).
          // The station network is already drawn, so the prompt is about the
          // live fleet only.
          coverage:
            (state._altitudeGateOpen
              ? `No feed here yet · ${TRANSIT_ENABLED_FEEDS.length} regions available`
              : `Fly below ${Math.round(ACTIVATION_ALTITUDE_M / 1000).toLocaleString('en-US')} km to a covered region`) +
            stationNote,
        };
      }
      // Age is shown by the same rule the row state uses, so the text and the
      // chip can never disagree about which feed has gone quiet.
      const coverage = active
        .map((feed) => {
          const status = parts.ingestion.feedStatus(feed.id);
          const quiet =
            status.stale === true ||
            (Number.isFinite(status.upstreamAt) &&
              now - status.upstreamAt > FEED_STALE_AFTER_MS);
          const aged =
            quiet && Number.isFinite(status.upstreamAt)
              ? ` (${Math.round((now - status.upstreamAt) / 1000)}s old)`
              : '';
          return `${feed.name} ${status.count}${aged}`;
        })
        .join(' · ');
      return {
        count: count + stationCount,
        countLabel: transitCountLabel(count, stationCount),
        lastUpdate: state._lastUpdate,
        error: count === 0 && stationCount === 0 ? health.error : null,
        ...(count === 0 && Number.isFinite(health.retryInSec)
          ? { retryInSec: health.retryInSec }
          : {}),
        degraded: count > 0 && health.degraded,
        loading: health.loading && count === 0 && stationCount === 0,
        loadingLabel:
          // i18n-ignore: English data, translated on display (ui/statusText.js)
          health.loading && count === 0
            ? `Loading ${active.map((feed) => feed.name).join(', ')}`
            : undefined,
        stale: health.stale,
        source: 'GTFS-RT · SNCF',
        coverage: coverage + stationNote,
        feeds: active.map((feed) => feed.id),
        stations: stationCount,
      };
    },
  };

  return { methods, refreshDetectCache };
}
