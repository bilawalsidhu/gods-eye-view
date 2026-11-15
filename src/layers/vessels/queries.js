import * as Cesium from 'cesium';
import { t, msg } from '../../i18n/index.js';
import { vesselCockpitInfo } from './cockpitSubject.js';
import { vesselTypeCss } from '../../data/vesselLabels.js';
import { greatCircleMeters } from '../../geoDistance.js';

// ingestion.js is a portable export (package.json) and writes English labels
// into state; translate the known ones here, pass anything else through.
const FEED_STATE_LABEL_KEYS = Object.freeze({
  'refreshing...': msg('refreshing...'),
  'loading...': msg('loading...'),
  'awaiting first AIS position…': msg('awaiting first AIS position…'),
});

function localizeFeedLabel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return raw;
  const key = FEED_STATE_LABEL_KEYS[raw.trim()];
  return key ? t(key) : raw;
}
import {
  AIS_DEGRADED_STATUSES,
  AIS_HEALTHY_STATUSES,
  AIS_STATUS_REASON,
  REFRESH_MS,
  FOCUS_EVIDENCE_DEV,
  VESSEL_LIFT_M,
  followsClock,
} from './policy.js';
import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';

const UUID_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createQueries({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { formatKnots } = services.labels;

  /**
   * The vessel keyed `id`, else the first whose MMSI is `id`: a link or a
   * caller that names a vessel by its MMSI still finds it. A share link
   * carries a UUID key in lowercase, so a UUID matches in any case.
   * @param {string} id
   * @returns {object|null}
   */
  function recordFor(id) {
    const record = state.records.byId?.get(id);
    if (record) return record;
    if (UUID_KEY.test(id)) {
      const wanted = id.toLowerCase();
      for (const candidate of state.records.byId?.values() ?? [])
        if (candidate.id.toLowerCase() === wanted) return candidate;
      return null;
    }
    if (!/^\d{1,10}$/.test(id)) return null;
    for (const candidate of state.records.byId?.values() ?? [])
      if (candidate.mmsi === id) return candidate;
    return null;
  }

  /**
   * Seconds until the server's next reconnect attempt, or 0 when none is
   * scheduled. Mirrors the flights layer's `retryInSec` chip affordance.
   * @returns {number}
   */

  function aisRetryInSec() {
    // A rejected key is terminal until someone changes it; an hour-long
    // countdown would imply waiting is the fix.
    if (state.feed.transportStatus === 'auth-failed') return 0;
    const at = Number(state.feed.nextAttemptAt);
    if (!Number.isFinite(at) || at <= 0) return 0;
    return Math.max(0, Math.ceil((at - vesselState._aisRuntime.now()) / 1000));
  }

  /**
   * Chip text for a feed the server has reported as not delivering.
   * @param {string} status - 'stale' | 'reconnecting' | 'down'
   * @param {Object} payload - Parsed /api/vessels JSON.
   * @returns {string}
   */

  function describeDegradedAisFeed(status, payload) {
    if (status === 'auth-failed') {
      // Actionable, not a countdown: retrying cannot fix a rejected credential,
      // so the chip asks the operator to do the one thing that can.
      return t('API key rejected — check AISSTREAM_API_KEY');
    }
    if (status === 'stale') {
      const silentSec = Math.round(Number(payload?.silentForMs) / 1000);
      return Number.isFinite(silentSec) && silentSec > 0
        ? t('feed silent {seconds}s — no AIS data', { seconds: silentSec })
        : t('feed silent — no AIS data');
    }
    const attempt = Number(payload?.reconnectAttempt);
    if (Number.isFinite(attempt) && attempt >= 1)
      return status === 'down'
        ? t('feed down — retrying slowly (attempt {attempt})', { attempt })
        : t('reconnecting to feed… (attempt {attempt})', { attempt });
    return status === 'down'
      ? t('feed down — retrying slowly')
      : t('reconnecting to feed…');
  }

  /**
   * Derive a surfaced error string from an /api/vessels payload, or null when the
   * feed has accepted product data. Socket transport, message receipt, and usable
   * vessel positions are separate health stages: an open socket with no message
   * or no accepted positions must not read as a fresh successful update.
   *
   * @param {Object|null|undefined} payload - Parsed /api/vessels JSON.
   * @param {number} acceptedRowCount - Number of rows accepted by vessel normalization.
   * @returns {string|null} A short reason for the chip, or null if healthy.
   */

  function deriveAisFeedError(payload, acceptedRowCount) {
    const status =
      payload && typeof payload.status === 'string' ? payload.status : null;
    // A feed the server reports as not delivering outranks the row count: the
    // cached vessels on screen are exactly what makes an outage invisible.
    if (status && AIS_DEGRADED_STATUSES.has(status)) {
      return describeDegradedAisFeed(status, payload);
    }
    if (acceptedRowCount > 0) return null; // accepted rows may be stale while reconnecting, but remain usable
    if (AIS_HEALTHY_STATUSES.has(status)) {
      return payload?.lastMessageAt
        ? t('awaiting usable AIS positions…')
        : t('awaiting first AIS message…');
    }
    if (!status) return null;
    const detail =
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : '';
    // The reasons are English in policy.js (msg) and shown in the UI language.
    const reason = t(AIS_STATUS_REASON[status] || msg('feed unavailable'));
    return detail && !AIS_STATUS_REASON[status]
      ? `${reason} (${detail})`
      : reason;
  }

  /** True when a raw AIS row can enter the production vessel normalizer. */

  function hasUsableVesselCoordinates(row) {
    return (
      Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon))
    );
  }

  /**
   * Classify one server snapshot before any destructive reconciliation.
   * @param {Object|null|undefined} payload - Parsed /api/vessels payload.
   * @returns {{emptyCoverage: boolean, transportStatus: string|null, lastMessageAt: number|string|null,
   *   rawRows: Array<Object>, acceptedRows: Array<Object>, rawRowCount: number,
   *   acceptedRowCount: number, error: string|null}}
   */

  function classifyAisFeedSnapshot(payload) {
    const rawRows = Array.isArray(payload?.rows) ? payload.rows : [];
    const acceptedRows = rawRows.filter(hasUsableVesselCoordinates);
    const transportStatus =
      typeof payload?.status === 'string' ? payload.status : null;
    const lastMessageAt = payload?.lastMessageAt ?? null;
    const acceptedRowCount = acceptedRows.length;
    const emptyCoverage =
      rawRows.length === 0 &&
      payload?.rawRowCount === 0 &&
      payload?.complete === true &&
      payload?.freshness === 'current' &&
      AIS_HEALTHY_STATUSES.has(transportStatus) &&
      Number.isFinite(Number(lastMessageAt)) &&
      Number(lastMessageAt) > 0;
    return {
      emptyCoverage,
      transportStatus,
      lastMessageAt,
      rawRows,
      acceptedRows,
      rawRowCount:
        Number.isInteger(payload?.rawRowCount) &&
        payload.rawRowCount >= rawRows.length
          ? payload.rawRowCount
          : rawRows.length,
      acceptedRowCount,
      error: emptyCoverage
        ? null
        : deriveAisFeedError(payload, acceptedRowCount) ||
          (acceptedRowCount === 0 ? t('awaiting usable AIS positions…') : null),
    };
  }

  /**
   * Map one internal vessel record to a plain JSON-safe analyst record
   * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
   * fields are null, never NaN/undefined. navStatus is always null: the
   * /api/vessels proxy does not surface AIS NavigationalStatus, so it
   * cannot be derived client-side.
   * @param {Object|null|undefined} record - `state.records.byId`/`state.records.all` entry.
   * @returns {{id: string|null, vesselId: string|null, mmsi: string|null,
   *   name: string|null,
   *   lat: number|null, lon: number|null, speedKts: number|null,
   *   courseDeg: number|null, shipType: string|null, destination: string|null,
   *   navStatus: null}}
   */

  function mapAnalystRecord(record) {
    const num = (v) => (Number.isFinite(v) ? v : null);
    const text = (v) => {
      const t = String(v ?? '').trim();
      return t || null;
    };
    const vesselId = text(record?.id);
    const mmsi = text(record?.mmsi);
    const name = text(record?.name);
    return {
      // A display label, as every layer's analyst `id` is; `vesselId` is the
      // key and `mmsi` the vessel's MMSI when known.
      id: name || mmsi || vesselId,
      vesselId,
      mmsi,
      name,
      lat: num(record?.lat),
      lon: num(record?.lon),
      speedKts: num(record?.speed),
      courseDeg: num(record?.course),
      shipType: text(record?.type),
      destination: text(record?.destination),
      navStatus: null,
    };
  }

  /**
   * Ellipsoidal render height (m) for a sea-surface object: the local geoid
   * undulation N plus a small lift. The sea surface ≈ the geoid, which sits
   * −106…+85 m off the WGS84 ellipsoid worldwide (Rotterdam ≈ +45 m — at
   * height 0 the tile sea mesh occludes every chevron; Houston ≈ −27 m).
   * Pure seam, exported for unit tests.
   * @param {number|null|undefined} geoidN - Undulation N (m), or null/undefined while the grid is cold.
   * @param {number} liftM - Lift above the sea surface (m).
   * @returns {number} Ellipsoidal height h = N + lift (N treated as 0 when absent).
   */

  function vesselDatumHeightM(geoidN, liftM) {
    return (Number.isFinite(geoidN) ? geoidN : 0) + liftM;
  }

  /**
   * Reduce one vessel-selection gesture to the layer-owned action it should
   * perform. The interaction handler reserves only vessel-record residuals and
   * trail picks as no-ops. The interaction wire also reserves sibling-owned
   * picks before this reducer so their camera action cannot mutate AIS state.
   *
   * @param {{selectedId?: string|number|null, pickedId?: string|number|null,
   *   gesture?: 'click'|'escape'}} input - Current selection plus owned pick.
   * @returns {{action: 'none'|'select'|'deselect'}}
   */

  function reduceVesselSelection(input = {}) {
    const selectedId = normalizeSelectionId(input.selectedId);
    const pickedId = normalizeSelectionId(input.pickedId);
    const gesture = input.gesture || 'click';

    if (gesture === 'escape') {
      return selectedId ? { action: 'deselect' } : { action: 'none' };
    }
    if (gesture !== 'click') {
      return { action: 'none' };
    }
    if (pickedId) {
      if (pickedId === selectedId) {
        return { action: 'none' };
      }
      return { action: 'select' };
    }
    return selectedId ? { action: 'deselect' } : { action: 'none' };
  }

  function normalizeSelectionId(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  }
  const methods = {
    mapAnalystRecord,
    deriveAisFeedError,
    classifyAisFeedSnapshot,
    vesselDatumHeightM,
    reduceVesselSelection,

    id: 'ais-live-vessels',

    name: 'Live AIS Vessels',

    icon: '◭',

    source: 'AISStream',

    updateInterval: REFRESH_MS,

    statsRefreshInterval: 1000,

    /**
     * Find a vessel by its exact id, exact MMSI or case-insensitive name
     * substring. Vessels can share an MMSI; the first that has it is found.
     * @param {string|number} query Vessel id, MMSI or partial vessel name.
     * @returns {{ id: string, mmsi: string, name: string, position: Cesium.Cartesian3, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
     */
    findByQuery(query) {
      if (query === null || query === undefined) return null;
      const records = state.records.all;
      if (!Array.isArray(records) || !records.length) return null;
      const q = String(query).trim();
      if (!q) return null;

      let record = state.records.byId.get(q) || null;
      if (!record && /^\d+$/.test(q)) {
        record = records.find((r) => r.mmsi === q) || null;
      }
      if (!record) {
        const lower = q.toLowerCase();
        record =
          records.find((r) =>
            String(r.name || '')
              .toLowerCase()
              .includes(lower),
          ) || null;
      }
      if (!record) return null;

      const position =
        components.rendering.getVisual(record).billboard?.position ||
        components.rendering.getVisual(record).position;
      if (!position) return null;
      return {
        id: record.id,
        mmsi: record.mmsi,
        name: record.name,
        position,
        latitude: record.lat,
        longitude: record.lon,
        speedKt: record.speed,
        course: record.course,
        type: record.type,
      };
    },

    /**
     * Get vessels within a range of a point, sorted nearest-first.
     * @param {Cesium.Cartesian3} centerCartesian Center of the search.
     * @param {number} rangeM Max distance in meters (non-finite = unbounded).
     * @param {number} [maxCount=25] Maximum entries to return.
     * @returns {Array<{ id: string, mmsi: string, name: string, position: Cesium.Cartesian3, distanceM: number }>}
     */
    getNearby(centerCartesian, rangeM, maxCount = 25) {
      const records = state.records.all;
      if (!centerCartesian || !Array.isArray(records) || !records.length)
        return [];
      const range = Number.isFinite(rangeM) && rangeM > 0 ? rangeM : Infinity;
      const cap =
        Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 25;

      const entries = [];
      for (const record of records) {
        const visual = components.rendering.getVisual(record);
        if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
          continue;
        const position = visual.billboard?.position || visual.position;
        if (!position) continue;
        const distanceM = Cesium.Cartesian3.distance(centerCartesian, position);
        if (!Number.isFinite(distanceM) || distanceM > range) continue;
        entries.push({
          id: record.id,
          mmsi: record.mmsi,
          name: record.name,
          position,
          distanceM,
        });
      }
      entries.sort((a, b) => a.distanceM - b.distanceM);
      return entries.slice(0, cap);
    },

    /**
     * Vessels around a point for the Cockpit bridge radar, nearest first.
     * The ship whose bridge the Cockpit occupies is left out. Distances are
     * great-circle from the AIS positions, so no rendered visual is needed.
     * @param {number} lat Latitude of the centre, degrees.
     * @param {number} lon Longitude of the centre, degrees.
     * @param {number} rangeM Max distance in metres.
     * @param {number} [maxCount=60] Maximum entries to return.
     * @returns {Array<{ id: string, name: string, latitude: number,
     *   longitude: number, course: number|null, heading: number|null,
     *   type: string, color: string, stale: boolean }>} Empty while the
     *   layer is off. A ship with no id has an `unkeyed:` id.
     */
    getRadarContacts(lat, lon, rangeM, maxCount = 60) {
      const records = state.records.all;
      if (!state.feed.enabled || !Array.isArray(records) || !records.length)
        return [];
      if (!Number.isFinite(rangeM) || rangeM <= 0) return [];
      const cap =
        Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 60;
      const center = { lat, lon };
      const subject = state.cockpitSubjectId;
      const finite = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
      };

      const entries = [];
      records.forEach((record, index) => {
        if (subject && String(record.id) === subject) return;
        const distanceM = greatCircleMeters(center, {
          lat: record.lat,
          lon: record.lon,
        });
        if (!(distanceM <= rangeM)) return;
        entries.push({ record, index, distanceM });
      });
      entries.sort((a, b) => a.distanceM - b.distanceM);
      return entries.slice(0, cap).map(({ record, index }) => ({
        // A ship with no id still needs a key of its own on the scope.
        id: record.id ? String(record.id) : `unkeyed:${index}`,
        name: String(record.name || record.mmsi || ''),
        latitude: record.lat,
        longitude: record.lon,
        course: finite(record.course),
        heading: finite(record.heading),
        type: String(record.type || ''),
        color: vesselTypeCss(record.type),
        stale: (record.missedRefreshes || 0) > 0,
      }));
    },

    /**
     * Get positions of all currently loaded vessels.
     * @param {number} [maxCount=800] Maximum entries to return.
     * @returns {Array<{ id: string, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number }>}
     */
    /**
     * Whether this layer still carries a vessel, in O(1).
     *
     * Mirror of `flights.hasContact`: presence consumers must not infer absence
     * from the capped `getAllPositions` rows. Records are keyed by id.
     * A disabled layer keeps its records, so it must decline rather than answer
     * from data the user can no longer see.
     * @param {string} id Vessel id.
     * @returns {boolean|null} Presence, or null when the layer is disabled or
     *   holds no data and therefore cannot answer.
     */
    hasContact(id) {
      if (
        !state.feed.enabled ||
        !state.records.byId ||
        state.records.byId.size === 0
      )
        return null;
      if (!id) return false;
      return Boolean(recordFor(String(id).trim()));
    },

    getAllPositions(maxCount = 800) {
      const result = [];
      const records = state.records.all;
      if (!Array.isArray(records)) return result;
      const cap =
        Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 800;

      for (const record of records) {
        const visual = components.rendering.getVisual(record);
        if (result.length >= cap) break;
        const position = visual.billboard?.position || visual.position;
        if (!position) continue;
        result.push({
          id: record.id,
          label: record.name || record.mmsi || record.id,
          position,
          latitude: record.lat,
          longitude: record.lon,
        });
      }
      return result;
    },

    /**
     * Snapshot the layer's in-memory vessel records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!state.feed.enabled) return [];
      const records = state.records.all;
      if (!Array.isArray(records) || !records.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const record of records) {
        if (result.length >= limit) break;
        result.push(mapAnalystRecord(record));
      }
      return result;
    },

    /**
     * Select a vessel by id via the same path as a map click
     * (highlight + HUD update). An AIS feed's vessels are keyed by MMSI.
     * @param {string|number} id Vessel id.
     * @returns {boolean} True if a matching vessel was selected.
     */
    selectById(id) {
      if (id === null || id === undefined) return false;
      const target = String(id).trim();
      if (!target) return false;
      const record = recordFor(target);
      if (!record) return false;
      components.selection.selectVessel(record);
      return true;
    },

    /**
     * Clear the current vessel selection and reset the HUD readout.
     * @returns {boolean} Always true.
     */
    clearSelection() {
      components.selection.clearVesselInspection();
      return true;
    },

    /**
     * Get info about the currently selected vessel.
     * @returns {{ id: string, mmsi: string, name: string, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
     */
    getSelectedInfo() {
      const record = state.selectedRecord;
      if (!record) return null;
      return {
        id: record.id,
        mmsi: record.mmsi,
        name: record.name,
        latitude: record.lat,
        longitude: record.lon,
        speedKt: record.speed,
        course: record.course,
        type: record.type,
      };
    },

    /**
     * Where the selected vessel is drawn now, for a share link that names it:
     * its id, its drawn position and the time that position stands for (the
     * world time while the layer follows the clock, else its fix's time).
     * @returns {{ id: string, position: Cesium.Cartesian3, observedAtMs: number|null }|null}
     *   Null when the layer is off, nothing is selected or it is not drawn.
     */
    getSelectedFix() {
      if (!state.feed.enabled) return null;
      const record = state.selectedRecord;
      if (!record?.id) return null;
      const visual = components.rendering.getVisual(record);
      const position = visual?.billboard?.position || visual?.position;
      if (!position) return null;
      const fixEpoch = record.lastPositionEpoch;
      const observedAtMs = followsClock(vesselState)
        ? vesselState.worldNow()
        : Number.isFinite(fixEpoch)
          ? fixEpoch * 1000
          : (record.fixReceivedAtMs ?? null);
      return {
        id: record.id,
        position,
        observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
      };
    },

    /**
     * Describe the selected vessel for the Cockpit bridge view.
     * @returns {object|null} `vesselCockpitInfo` fields plus `seaSurfaceHeightM`
     *   (the local geoid height the sprite datum uses) and `markHeightM` (the
     *   height the sprite is drawn at), or null when the layer is off or
     *   nothing is selected.
     */
    getCockpitSubject() {
      if (!state.feed.enabled) return null;
      const info = vesselCockpitInfo(state.selectedRecord);
      if (!info) return null;
      const geoidN = components.tracking.currentGeoidN(
        info.latitude,
        info.longitude,
      );
      return {
        ...info,
        seaSurfaceHeightM: vesselDatumHeightM(geoidN, 0),
        markHeightM: vesselDatumHeightM(geoidN, VESSEL_LIFT_M),
      };
    },

    /**
     * Mark the vessel whose bridge the Cockpit camera occupies, or release it.
     * Its sprite, card and detection bracket stay hidden while it is held.
     * @param {string|number|null} id Subject vessel id, or null to release.
     * @returns {boolean} Always true.
     */
    setCockpitSubject(id) {
      const next = normalizeSelectionId(id);
      if (state.cockpitSubjectId === next) return true;
      state.cockpitSubjectId = next;
      // The ridden ship's trail runs from under the eye: hidden, its history
      // kept, while the bridge holds the ship it belongs to.
      state.trail?.setVisible?.(!next || next !== state.trailId);
      components.rendering.updateVisibility(true);
      return true;
    },

    /**
     * Return the camera to the selected vessel's map view, as a click on it does.
     * @returns {boolean} True when a selected vessel took the camera.
     */
    focusSelectedVessel() {
      const record = state.selectedRecord;
      if (!record || !state.feed.enabled) return false;
      return components.selection.selectAndFocusVessel(record);
    },

    /**
     * Return a subset of vessels for the universal detection overlay.
     * Deterministic stride sampling distributes selections evenly across the
     * current record list while honoring the overlay's per-layer budget.
     * @param {Object} [options={}] - Options from the detection system.
     * @param {number} [options.maxCount] - Maximum objects to return (defaults to all).
     * @param {number} [options.seed] - Seed offset for stride sampling.
     * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean, cardSourceId: string, cardEntryId: string}>}
     */
    getDetectableObjects(options = {}) {
      if (
        !state.feed.enabled ||
        !state.billboardCollection ||
        !state.billboardCollection.show
      )
        return [];
      const records = state.records.all;
      if (!Array.isArray(records) || !records.length) return [];

      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : records.length;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      // Deterministic stride: evenly space selections across the record list
      const stride = Math.max(1, Math.ceil(records.length / maxCount));
      const start = seed % stride;

      const selected = state.selectedRecord;
      const result = [];
      for (let idx = 0; idx < records.length; idx += 1) {
        if ((idx - start) % stride !== 0) continue;
        const record = records[idx];
        const visual = components.rendering.getVisual(record);
        // A vessel drawn as its model is present though its chevron is hidden.
        if (
          visual.billboard &&
          !visual.billboard.show &&
          !visual.modelOwnsVisual
        )
          continue;
        const position = visual.billboard?.position || visual.position;
        if (!position) continue;
        result.push({
          position,
          sourceId: record.id,
          id: record.name || record.mmsi || 'VESSEL',
          type: 'SEA',
          skipLabel: record === selected,
          // Detection hides the callout while this card paints.
          cardSourceId: VESSEL_OVERLAY_SOURCE_ID,
          cardEntryId: components.cards.vesselOverlayEntryId(record),
          klass: record.type
            ? String(record.type).toUpperCase().slice(0, 14)
            : undefined,
          metric: formatKnots(record.speed), // record.speed is knots
        });
        if (result.length >= maxCount) break;
      }
      return result;
    },

    ...(FOCUS_EVIDENCE_DEV
      ? {
          __focusEvidence: Object.freeze({
            setVessels: components.evidence._setFocusEvidenceVessels,
            snapshot: components.evidence._focusEvidenceVesselSnapshot,
          }),
        }
      : {}),

    getStats() {
      const waitingForFirstPosition =
        state.feed.firstConnectPhase === 'loading';
      return {
        count: state.feed.count,
        lastUpdate: state.feed.lastUpdate,
        loading: state.feed.loading || waitingForFirstPosition,
        loadingLabel: waitingForFirstPosition
          ? t('awaiting first AIS position…')
          : localizeFeedLabel(state.feed.loadingLabel),
        error: state.feed.error,
        stale: state.feed.stale,
        partial: state.feed.partial,
        status:
          state.feed.firstConnectPhase === 'unavailable'
            ? 'unavailable'
            : undefined,
        transportStatus: state.feed.transportStatus,
        lastMessageAt: state.feed.lastMessageAt,
        rawRowCount: state.feed.rawRowCount,
        acceptedRowCount: state.feed.acceptedRowCount,
        // Same chip affordance the flights layer uses: when the server is
        // backing off, say how long until the next attempt instead of leaving
        // the user to guess whether anything is still happening.
        retryInSec: aisRetryInSec(),
        // Same field as flights and military, so Contacts names the provider.
        source: layer.source,
        // Following the world clock, the snapshot's age is told from its time.
        ...(followsClock(vesselState) && { atMs: vesselState.worldNow() }),
      };
    },
  };

  return {
    aisRetryInSec,
    describeDegradedAisFeed,
    deriveAisFeedError,
    hasUsableVesselCoordinates,
    classifyAisFeedSnapshot,
    mapAnalystRecord,
    vesselDatumHeightM,
    reduceVesselSelection,
    normalizeSelectionId,
    methods,
  };
}
