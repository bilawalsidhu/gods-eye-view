import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  AIS_DEGRADED_STATUSES,
  AIS_HEALTHY_STATUSES,
  AIS_STATUS_REASON,
  REFRESH_MS,
  FOCUS_EVIDENCE_DEV,
} from './policy.js';

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
   * Seconds until the server's next reconnect attempt, or 0 when none is
   * scheduled. Mirrors the flights layer's `retryInSec` chip affordance.
   * @returns {number}
   */

  function aisRetryInSec() {
    // A rejected key is terminal until someone changes it; an hour-long
    // countdown would imply waiting is the fix.
    if (state.transportStatus === 'auth-failed') return 0;
    const at = Number(state.nextAttemptAt);
    if (!Number.isFinite(at) || at <= 0) return 0;
    return Math.max(0, Math.ceil((at - vesselState._aisRuntime.now()) / 1000));
  }

  /**
   * Chip text for a feed the server has reported as not delivering.
   * @param {string} status - 'stale' | 'reconnecting' | 'down'
   * @param {Object} payload - Parsed /api/ais-live JSON.
   * @returns {string}
   */

  function describeDegradedAisFeed(status, payload) {
    if (status === 'auth-failed') {
      // Actionable, not a countdown: retrying cannot fix a rejected credential,
      // so the chip asks the operator to do the one thing that can.
      return 'API key rejected — check AISSTREAM_API_KEY';
    }
    if (status === 'stale') {
      const silentSec = Math.round(Number(payload?.silentForMs) / 1000);
      return Number.isFinite(silentSec) && silentSec > 0
        ? `feed silent ${silentSec}s — no AIS data`
        : 'feed silent — no AIS data';
    }
    const attempt = Number(payload?.reconnectAttempt);
    const suffix =
      Number.isFinite(attempt) && attempt >= 1 ? ` (attempt ${attempt})` : '';
    return status === 'down'
      ? `feed down — retrying slowly${suffix}`
      : `reconnecting to feed…${suffix}`;
  }

  /**
   * Derive a surfaced error string from an /api/ais-live payload, or null when the
   * feed has accepted product data. Socket transport, message receipt, and usable
   * vessel positions are separate health stages: an open socket with no message
   * or no accepted positions must not read as a fresh successful update.
   *
   * @param {Object|null|undefined} payload - Parsed /api/ais-live JSON.
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
        ? 'awaiting usable AIS positions…'
        : 'awaiting first AIS message…';
    }
    if (!status) return null;
    const detail =
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : '';
    const reason = AIS_STATUS_REASON[status] || 'feed unavailable';
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
   * @param {Object|null|undefined} payload - Parsed /api/ais-live payload.
   * @returns {{transportStatus: string|null, lastMessageAt: number|string|null,
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
    return {
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
      error:
        deriveAisFeedError(payload, acceptedRowCount) ||
        (acceptedRowCount === 0 ? 'awaiting usable AIS positions…' : null),
    };
  }

  /**
   * Map one internal vessel record to a plain JSON-safe analyst record
   * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
   * fields are null, never NaN/undefined. navStatus is always null: the
   * /api/ais-live proxy does not surface AIS NavigationalStatus, so it
   * cannot be derived client-side.
   * @param {Object|null|undefined} record - `state.vesselMap`/`state.vesselRecords` entry.
   * @returns {{id: string|null, mmsi: string|null, name: string|null,
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
    const mmsi = text(record?.mmsi);
    const name = text(record?.name);
    return {
      id: name || mmsi,
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
   * @param {{selectedMmsi?: string|number|null, pickedMmsi?: string|number|null,
   *   gesture?: 'click'|'escape'}} input - Current selection plus owned pick.
   * @returns {{action: 'none'|'select'|'deselect'}}
   */

  function reduceVesselSelection(input = {}) {
    const selectedMmsi = normalizeSelectionMmsi(input.selectedMmsi);
    const pickedMmsi = normalizeSelectionMmsi(input.pickedMmsi);
    const gesture = input.gesture || 'click';

    if (gesture === 'escape') {
      return selectedMmsi ? { action: 'deselect' } : { action: 'none' };
    }
    if (gesture !== 'click') {
      return { action: 'none' };
    }
    if (pickedMmsi) {
      if (pickedMmsi === selectedMmsi) {
        return { action: 'none' };
      }
      return { action: 'select' };
    }
    return selectedMmsi ? { action: 'deselect' } : { action: 'none' };
  }

  function normalizeSelectionMmsi(value) {
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
     * Find a vessel by exact MMSI or case-insensitive name substring.
     * @param {string|number} query MMSI or partial vessel name.
     * @returns {{ mmsi: string, name: string, position: Cesium.Cartesian3, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
     */
    findByQuery(query) {
      if (query === null || query === undefined) return null;
      const records = state.vesselRecords;
      if (!Array.isArray(records) || !records.length) return null;
      const q = String(query).trim();
      if (!q) return null;

      let record = null;
      if (/^\d+$/.test(q)) {
        record = state.vesselMap.get(q) || null;
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

      const position = record.billboard?.position || record.position;
      if (!position) return null;
      return {
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
     * @returns {Array<{ mmsi: string, name: string, position: Cesium.Cartesian3, distanceM: number }>}
     */
    getNearby(centerCartesian, rangeM, maxCount = 25) {
      const records = state.vesselRecords;
      if (!centerCartesian || !Array.isArray(records) || !records.length)
        return [];
      const range = Number.isFinite(rangeM) && rangeM > 0 ? rangeM : Infinity;
      const cap =
        Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 25;

      const entries = [];
      for (const record of records) {
        if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
          continue;
        const position = record.billboard?.position || record.position;
        if (!position) continue;
        const distanceM = Cesium.Cartesian3.distance(centerCartesian, position);
        if (!Number.isFinite(distanceM) || distanceM > range) continue;
        entries.push({
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
     * Get positions of all currently loaded vessels.
     * @param {number} [maxCount=800] Maximum entries to return.
     * @returns {Array<{ id: string, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number }>}
     */
    /**
     * Whether this layer still carries a vessel, in O(1).
     *
     * Mirror of `flights.hasContact`: presence consumers must not infer absence
     * from the capped `getAllPositions` rows. `vesselMap` is MMSI-keyed.
     * A disabled layer keeps its records, so it must decline rather than answer
     * from data the user can no longer see.
     * @param {string} mmsi Vessel identifier.
     * @returns {boolean|null} Presence, or null when the layer is disabled or
     *   holds no data and therefore cannot answer.
     */
    hasContact(mmsi) {
      if (!state.enabled || !state.vesselMap || state.vesselMap.size === 0)
        return null;
      if (!mmsi) return false;
      return state.vesselMap.has(String(mmsi).trim());
    },

    getAllPositions(maxCount = 800) {
      const result = [];
      const records = state.vesselRecords;
      if (!Array.isArray(records)) return result;
      const cap =
        Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 800;

      for (const record of records) {
        if (result.length >= cap) break;
        const position = record.billboard?.position || record.position;
        if (!position) continue;
        result.push({
          id: record.mmsi,
          label: record.name || record.mmsi,
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
      if (!state.enabled) return [];
      const records = state.vesselRecords;
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
     * Select a vessel by MMSI via the same path as a map click
     * (highlight + HUD update).
     * @param {string|number} mmsi Vessel MMSI.
     * @returns {boolean} True if a matching vessel was selected.
     */
    selectById(mmsi) {
      if (mmsi === null || mmsi === undefined) return false;
      const target = String(mmsi).trim();
      if (!target) return false;
      const record = state.vesselMap.get(target);
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
     * @returns {{ mmsi: string, name: string, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
     */
    getSelectedInfo() {
      const record = state.selectedRecord;
      if (!record) return null;
      return {
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
     * Return a subset of vessels for the universal detection overlay.
     * Deterministic stride sampling distributes selections evenly across the
     * current record list while honoring the overlay's per-layer budget.
     * @param {Object} [options={}] - Options from the detection system.
     * @param {number} [options.maxCount] - Maximum objects to return (defaults to all).
     * @param {number} [options.seed] - Seed offset for stride sampling.
     * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean}>}
     */
    getDetectableObjects(options = {}) {
      if (
        !state.enabled ||
        !state.billboardCollection ||
        !state.billboardCollection.show
      )
        return [];
      const records = state.vesselRecords;
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
        if (record.billboard && !record.billboard.show) continue;
        const position = record.billboard?.position || record.position;
        if (!position) continue;
        result.push({
          position,
          sourceId: record.mmsi,
          id: record.name || record.mmsi || 'VESSEL',
          type: 'SEA',
          skipLabel: record === selected,
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
      const waitingForFirstPosition = state.firstConnectPhase === 'loading';
      return {
        count: state.count,
        lastUpdate: state.lastUpdate,
        loading: state.loading || waitingForFirstPosition,
        loadingLabel: waitingForFirstPosition
          ? t('layers.vessel.awaitingFirstPosition')
          : state.loadingLabel,
        error: state.error,
        stale: state.stale,
        status:
          state.firstConnectPhase === 'unavailable' ? 'unavailable' : undefined,
        transportStatus: state.transportStatus,
        lastMessageAt: state.lastMessageAt,
        rawRowCount: state.rawRowCount,
        acceptedRowCount: state.acceptedRowCount,
        // Same chip affordance the flights layer uses: when the server is
        // backing off, say how long until the next attempt instead of leaving
        // the user to guess whether anything is still happening.
        retryInSec: aisRetryInSec(),
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
    normalizeSelectionMmsi,
    methods,
  };
}
