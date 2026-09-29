import { displayedKinematics } from '../../data/motionModel.js';
import * as Cesium from 'cesium';
import { isExplicitLayerStateOrigin } from '../../data/layerState.js';
import { aircraftIncludedInNearby } from '../../data/aircraftNearbyPolicy.js';
import { modelVisualAnchor } from '../../data/modelVisualAnchor.js';
import {
  rankContactMatch,
  contactMatchWins,
  CONTACT_MATCH_TIER,
} from '../../data/contactMatch.js';
import { LANDED_ALT_MAX_FT, LANDED_SPEED_MAX_MPS } from './policy.js';

export function createQueries({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { tr3bAircraftClass, tr3bTypeLabel } = services.aircraftPresentation;
  const { formatFlightLevel } = services.labels;
  const { applyTrackedCameraFrame } = services.camera;

  /**
   * Coerce a value to a finite number, returning null if not possible.
   * Handles both numeric and string inputs (e.g. API fields that may arrive as strings).
   * @param {*} value - Raw value from the API response
   * @returns {number|null} Finite number or null
   */

  function _toFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = Number.parseFloat(value.trim());
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * Safely convert a value to a trimmed string, defaulting to '' for falsy inputs.
   * @param {*} value - Raw value to stringify
   * @returns {string} Trimmed string
   */

  function _toCleanText(value) {
    return String(value || '').trim();
  }

  /**
   * Format an altitude value in feet for display, with fallback text.
   * @param {number|null|undefined} altitudeFt - Barometric altitude in feet
   * @returns {string} Formatted altitude string (e.g. "35000 ft" or "Alt unknown")
   */

  function _formatAltitude(altitudeFt) {
    if (!Number.isFinite(altitudeFt)) return 'Alt unknown';
    return `${Math.round(altitudeFt)} ft`;
  }

  /**
   * True when the aircraft's latest metadata reads "on or about the runway"
   * (low + slow) — see the landed fast-cull rationale above. Both gates must
   * hold, so a plane missing either datum keeps the normal grace.
   * @param {string} icao24 - ICAO hex identifier of the aircraft
   * @returns {boolean}
   */

  function _likelyLanded(icao24) {
    const info = flightState.records.data.get(icao24);
    if (!info) return false;
    // Round 7 (mirror of flights.js): fast cull only for contacts seen
    // AIRBORNE this session — parked contacts ride the normal grace so feed
    // flaps don't churn their identity/floor state.
    if (info.wasAirborne !== true) return false;
    if (info.onGround) return true;
    return (
      Number.isFinite(info.altitudeFt) &&
      info.altitudeFt < LANDED_ALT_MAX_FT &&
      Number.isFinite(info.speedMps) &&
      info.speedMps < LANDED_SPEED_MAX_MPS
    );
  }

  /**
   * Build a public descriptor for one aircraft using its best current position
   * (dead-reckoned when history exists, billboard position otherwise).
   * @param {string} icao24 - ICAO hex identifier of the aircraft.
   * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null, verticalRateMps: number|null}|null}
   *   Descriptor with a cloned position, or null if the aircraft is unknown.
   */

  function _describeFlight(icao24) {
    const info = flightState.records.data.get(icao24);
    const bb = flightState._billboards.get(icao24);
    const basePos =
      parts.motion._deadReckon(icao24) || (bb ? bb.position : null);
    if (!basePos) return null;
    const displayed = displayedKinematics({
      derivedSpeedMps: flightState._drSpeedMps,
      derivedTrackDeg: flightState._drCourseDeg,
      reportedSpeedMps: info?.speedMps,
      reportedTrackDeg: info?.track,
    });
    const carto = Cesium.Cartographic.fromCartesian(
      basePos,
      Cesium.Ellipsoid.WGS84,
      flightState._scratchCarto,
    );
    if (!carto) return null;
    return {
      icao24,
      callsign: _toCleanText(info?.callsign) || null,
      // Additive: the label chain's middle link, trimmed like `callsign`, so
      // getTrackedSubject and the voice narration can read it straight off the
      // descriptor instead of reaching back into `_flightData`.
      registration: _toCleanText(info?.registration) || null,
      position: Cesium.Cartesian3.clone(basePos),
      latitude: Cesium.Math.toDegrees(carto.latitude),
      longitude: Cesium.Math.toDegrees(carto.longitude),
      // Keep the cockpit readout on the reported aviation altitude. Render
      // terrain height is a separate visual datum and may be below zero.
      altitudeM: Number.isFinite(info?.altitudeM)
        ? info.altitudeM
        : carto.height,
      renderAltitudeM: Number.isFinite(info?.renderAltitudeM)
        ? info.renderAltitudeM
        : carto.height,
      onGround: info?.onGround === true,
      velocityMps: displayed.speedMps,
      track: displayed.trackDeg,
      // Same field, same name, same null-when-absent rule as the civil
      // descriptor — the two layers store the record under different keys
      // (`verticalRateMps` here, `verticalRate` there), so only the mapping
      // makes `resolveTrackedAircraftInfo` hand back one shape for both.
      verticalRateMps: Number.isFinite(info?.verticalRateMps)
        ? info.verticalRateMps
        : null,
      stale: Boolean(
        flightState.records.missingPolls.get(icao24) ||
        flightState.feed._backoff,
      ),
    };
  }

  function _normalizeTrackedIcao(candidate) {
    const normalized = String(candidate ?? '')
      .trim()
      .toLowerCase();
    return normalized || null;
  }

  /**
   * Map one military aircraft's internal poll record to a plain JSON-safe
   * analyst record (analyst query engine seam) — same shape as the flights
   * layer's mapAnalystRecord, with `military` always true. Pure — no Cesium
   * types, no fetches. Missing/unknown fields are null, never NaN/undefined.
   * adsb.lol carries no origin-country field and this layer has no route
   * enrichment, so originCountry/routeOrigin/routeDestination are always null.
   * @param {string} icao24 - ICAO hex identifier of the aircraft.
   * @param {Object|null|undefined} info - `_flightData` record for this aircraft.
   * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
   *   lon: number|null, altitudeM: number|null, speedMps: number|null,
   *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
   *   military: boolean, aircraftClass: string|null, originCountry: null,
   *   operator: string|null, routeOrigin: null, routeDestination: null}}
   */

  function mapAnalystRecord(icao24, info) {
    const num = (v) => (Number.isFinite(v) ? v : null);
    const text = (v) => {
      const t = String(v ?? '').trim();
      return t || null;
    };
    const callsign = text(info?.callsign);
    return {
      id: callsign || text(info?.registration) || icao24,
      icao24,
      callsign,
      lat: num(info?.rawLat),
      lon: num(info?.rawLon),
      // altitudeFt is the sticky barometric/MSL aviation field — converted to
      // meters here for shape parity with the flights layer.
      altitudeM: Number.isFinite(info?.altitudeFt)
        ? info.altitudeFt * 0.3048
        : null,
      speedMps: num(info?.speedMps),
      heading: num(info?.track),
      verticalRateMps: num(info?.verticalRateMps),
      onGround: info?.onGround === true,
      military: true,
      // A converted contact reports the class it RENDERS as (mirror of
      // flights.js), so an analyst filter/superlative agrees with the triangle.
      aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
      originCountry: null,
      operator: text(info?.operator),
      routeOrigin: null,
      routeDestination: null,
    };
  }
  const methods = {
    mapAnalystRecord,

    id: 'military',

    name: 'Military Flights',

    icon: '🎖️',

    source: flightState.feed._lastSource,

    /** @type {number} Polling interval in ms between API fetches */
    updateInterval: 15000,

    /** @deprecated Compatibility alias for {@link enable}. */
    show(viewer) {
      this.enable(viewer);
    },

    /** @deprecated Compatibility alias for {@link disable}. */
    hide(viewer) {
      this.disable(viewer);
    },

    /**
     * Live layer params.
     * `models3d` toggles 3D glTF jet-model rendering for the FLEET (altitude-gated): when on,
     * surrounding military aircraft become 3D models once the camera is zoomed in past
     * MODEL_ALT_CEIL_M. The TRACKED contact is NOT gated by this — it takes its 3D model by
     * camera distance regardless (see `_trackedModelRegimeActive` / trackedModelRegime.js).
     * `models3dMode` is 'proximity' (nearest MODEL_MAX in view) or 'all' (every in-view plane).
     * @param {{models3d?: boolean, models3dMode?: 'proximity'|'all', selectedMilitaryTrackingId?: string|null}} params
     */
    setParams(params = {}, { origin = 'programmatic' } = {}) {
      if (
        isExplicitLayerStateOrigin(origin) &&
        !Object.hasOwn(params, 'selectedMilitaryTrackingId')
      ) {
        parts.tracking._cancelPendingTrackingRestore();
      }
      if (
        typeof params.models3d === 'boolean' &&
        params.models3d !== flightState._models3dEnabled
      ) {
        flightState._models3dEnabled = params.models3d;
        if (!flightState._models3dEnabled) {
          parts.rendering._releaseModels();
          parts.tracking._syncTracked2dRotation();
          // Restore fleet billboards (horizon-cull re-asserts next tick), but NEVER the tracked
          // plane's own fleet billboard — its tracked entity is the visual (avoids a double-image).
          if (flightState._billboardCollection)
            for (const [icao, bb] of flightState._billboards) {
              if (icao !== flightState._trackedIcao) bb.show = true;
            }
        }
      }
      if (
        (params.models3dMode === 'proximity' ||
          params.models3dMode === 'all') &&
        params.models3dMode !== flightState._models3dMode
      ) {
        // The next fleet tick re-derives the eligible set under the new cap and releases the overflow.
        flightState._models3dMode = params.models3dMode;
        if (flightState._cockpitContactMode) {
          parts.tracking._refreshCockpitNearContacts();
          flightState._lastFleetTickMs = 0;
        }
      }
      if (
        typeof params.irBoost === 'boolean' &&
        params.irBoost !== flightState._irBoost
      ) {
        flightState._irBoost = params.irBoost;
        parts.rendering._reloadModelsForIrBoost();
        // Sprites don't reload with the models — swap the TR-3B glyph between its
        // cold and thermal-reactive variants directly (mirror of flights.js).
        parts.tracking._refreshTr3bForStyle();
      }
      if (Object.hasOwn(params, 'selectedMilitaryTrackingId')) {
        const requested = _normalizeTrackedIcao(
          params.selectedMilitaryTrackingId,
        );
        if (requested === flightState._trackedIcao) {
          flightState._pendingTrackingRestore = null;
        } else if (requested === null) {
          parts.tracking._cancelPendingTrackingRestore();
          if (flightState._trackedIcao)
            parts.tracking._clearTracking(false, { origin });
        } else {
          const generation = ++flightState._trackingIntentGeneration;
          flightState._pendingTrackingRestore = {
            id: requested,
            generation,
            origin,
          };
          if (flightState._trackedIcao)
            parts.tracking._clearTracking(false, { origin });
          parts.tracking._applyPendingTrackingRestore();
        }
      }
      return true;
    },

    getParams() {
      return {
        models3d: flightState._models3dEnabled,
        models3dMode: flightState._models3dMode,
        irBoost: flightState._irBoost,
        selectedMilitaryTrackingId: flightState._trackedIcao,
      };
    },

    /**
     * Re-render a contact whose TR-3B conversion just flipped (Easter egg).
     * Callers own the registry write; this only re-derives what renders.
     * @param {string} icao24 - ICAO 24-bit address.
     * @returns {boolean} True when this layer owns the contact.
     */
    refreshTr3b(icao24) {
      return parts.tracking._refreshTr3bContact(icao24);
    },

    /**
     * Find military aircraft near a given ECEF position, sorted by distance.
     * Used by proximity-based features (e.g. detection overlay, spatial queries).
     * @param {Cesium.Cartesian3} center - Reference position in ECEF coordinates
     * @param {number} range - Maximum distance in meters (Infinity if not specified)
     * @param {number} [maxCount=50] - Maximum number of results to return
     * @param {object} [options] Query membership options.
     * @param {boolean} [options.includeHidden=false] Include loaded horizon-hidden aircraft.
     * @returns {Array<Object>} Sorted array of nearby aircraft descriptors
     */
    getNearby(center, range, maxCount = 50, { includeHidden = false } = {}) {
      if (
        !center ||
        !flightState._billboardCollection ||
        !flightState._billboardCollection.show
      )
        return [];

      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 50;
      const maxRange =
        Number.isFinite(range) && range > 0 ? range : Number.POSITIVE_INFINITY;

      const now = Cesium.JulianDate.now();
      const nearby = [];

      for (const [icao24, bb] of flightState._billboards) {
        const isTracked = icao24 === flightState._trackedIcao;
        // Keep planes rendered as a 3D model (billboard hidden) so proximity counts
        // don't drop to zero on the 2D→3D handoff; bb.position stays current while hidden.
        if (
          !aircraftIncludedInNearby({
            isTracked,
            billboardShown: bb.show,
            modelRendering: parts.rendering._modelOwnsVisual(icao24),
            includeHidden,
          })
        )
          continue;

        const trackedPos = isTracked
          ? parts.motion._trackedDisplayCached()
          : null; // cached, no recompute (anti-jitter)
        const pos = trackedPos || bb.position;
        if (!pos) continue;

        const distance = Cesium.Cartesian3.distance(center, pos);
        if (distance > maxRange) continue;

        const info = flightState.records.data.get(icao24);
        nearby.push({
          id: info?.callsign?.trim() || info?.registration?.trim() || icao24,
          icao24,
          position: pos,
          distance,
          // Filter surface (mirror of flights.js): the cockpit next/previous path
          // matches on this field, so it follows the conversion.
          aircraftClass: tr3bAircraftClass(
            icao24,
            String(info?.klass || info?.type || '')
              .trim()
              .toLowerCase() || null,
          ),
          track: info?.track ?? null,
          // Display type — converted too, so a Contacts row can't still name the
          // airframe the triangle replaced (the filter matcher reads this as a
          // fallback candidate as well).
          type: tr3bTypeLabel(icao24, info?.type || null),
          registration: info?.registration || null,
          operator: info?.operator || null,
          altitudeFt: info?.altitudeFt ?? null,
        });
      }

      nearby.sort((a, b) => a.distance - b.distance);
      return nearby.slice(0, limit);
    },

    /**
     * Return a subset of aircraft suitable for the detection overlay system.
     * Uses a deterministic stride-based sampling to keep the count manageable
     * while distributing selections evenly across the collection.
     * @param {Object} [options={}] - Options
     * @param {number} [options.maxCount] - Maximum objects to return (defaults to all)
     * @param {number} [options.seed] - Seed offset for stride sampling (for frame variation)
     * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean}>}
     */
    getDetectableObjects(options = {}) {
      if (
        !flightState._billboardCollection ||
        !flightState._billboardCollection.show
      )
        return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : flightState._billboards.size;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      // Deterministic stride: evenly space selections across the billboard map
      const stride = Math.max(
        1,
        Math.ceil(flightState._billboards.size / maxCount),
      );
      const start = seed % stride;

      const result = [];
      let idx = 0;
      for (const [icao24, bb] of flightState._billboards) {
        const shouldTake = (idx - start) % stride === 0;
        idx++;
        if (!shouldTake) continue;
        if (
          flightState._cockpitContactMode &&
          icao24.toLowerCase() === flightState._cockpitSubjectId
        )
          continue;
        const isTracked = icao24 === flightState._trackedIcao;
        // Keep planes rendered as a 3D model (billboard hidden) so the detection box
        // doesn't vanish on the 2D→3D handoff; bb.position stays current while hidden.
        const model = flightState._models.get(icao24);
        const modelOwnsVisual = parts.rendering._modelOwnsVisual(icao24);
        if (!isTracked && !bb.show && !modelOwnsVisual) continue;
        const info = flightState.records.data.get(icao24);
        const callsign = info?.callsign?.trim();
        const registration = info?.registration?.trim();
        let object = flightState._detectionObjects.get(icao24);
        if (!object) {
          object = {
            sourceId: icao24,
            type: 'AIR',
            tier: 'military',
            _weldPos: new Cesium.Cartesian3(),
          };
          flightState._detectionObjects.set(icao24, object);
        }
        // WELD (mirror of flights.js): anchor to whatever owns the visual. Model-owned
        // contacts read the translation the fleet tick already wrote into their
        // modelMatrix; sprite-owned contacts keep `bb.position`, where sprite and bracket
        // are co-located anyway.
        const spec = modelOwnsVisual
          ? parts.rendering._modelSpec(info?.klass)
          : null;
        const pos = isTracked
          ? parts.motion._trackedVisualCached() || bb.position
          : modelOwnsVisual
            ? modelVisualAnchor(
                model.modelMatrix,
                spec.visualCenterNative,
                Number.isFinite(model.computedScale)
                  ? model.computedScale
                  : spec.scale,
                object._weldPos || (object._weldPos = new Cesium.Cartesian3()),
              )
            : bb.position;
        if (!pos) continue;
        object.position = pos;
        object.skipLabel = isTracked;
        const id = callsign || registration || icao24;
        if (object.id !== id) object.id = id;
        // Card surface: detectionDraw composes its secondary line from
        // `[src.klass, src.metric]`, so a converted contact's card must name the
        // TR-3B, not the airframe underneath it.
        const klass = tr3bTypeLabel(icao24, info?.type || 'MIL');
        if (object.klass !== klass) object.klass = klass;
        const altitudeFt = info?.altitudeFt ?? 0;
        if (object._altitudeFt !== altitudeFt) {
          object._altitudeFt = altitudeFt;
          // military metadata stores altitudeFt (feet); the helper takes metres
          object.metric = formatFlightLevel(altitudeFt * 0.3048);
        }
        result.push(object);
        if (result.length >= maxCount) break;
      }
      if (
        flightState._detectionObjects.size >
        flightState._billboards.size + 512
      ) {
        for (const icao24 of flightState._detectionObjects.keys()) {
          if (!flightState._billboards.has(icao24))
            flightState._detectionObjects.delete(icao24);
        }
      }
      return result;
    },

    /**
     * Find a single aircraft by free-text query.
     * Match priority: exact icao24 hex, exact callsign, callsign prefix,
     * then callsign substring (all case-insensitive, trimmed).
     * @param {string} query - ICAO hex or full/partial callsign.
     * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
     *   Best match with a cloned, dead-reckoned position, or null if none.
     */
    findByQuery(query) {
      if (!flightState.records.data || flightState.records.data.size === 0)
        return null;
      const q = String(query || '')
        .trim()
        .toLowerCase();
      if (!q) return null;

      // Registration is searched alongside callsign because it is what the
      // operator SEES: a callsign-less contact reads as its tail number on the
      // card, in the analyst's answer, and in the Contacts list. Matching only
      // callsigns meant "follow 6606" — and the analyst → track_entity handoff
      // the tool instructions prescribe — answered "nothing matched" for the
      // very identity the app had just shown (owner field session 2026-08-21,
      // 23:48: three failed track_entity retries before a fallback stuck).
      // Ranking is shared with the flights layer (contactMatch.js) so the two
      // cannot disagree, and it is strictly tiered so a registration can never
      // out-rank a real callsign on feed order alone.
      let best = null;
      for (const [icao24, info] of flightState.records.data) {
        const candidate = {
          tier: rankContactMatch({
            query: q,
            hex: icao24,
            callsign: info?.callsign,
            registration: info?.registration,
          }),
          id: icao24,
        };
        if (!contactMatchWins(candidate, best)) continue;
        best = candidate;
        if (candidate.tier === CONTACT_MATCH_TIER.HEX_EXACT) break;
      }
      return best ? _describeFlight(best.id) : null;
    },

    /**
     * Return id/label/position for up to maxCount currently rendered aircraft.
     * Cheap snapshot for voice-tool framing — billboard positions only, no
     * dead reckoning and no cloning.
     * @param {number} [maxCount=500] - Maximum number of entries to return.
     * @returns {Array<{id: string, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number}>}
     */
    /**
     * Whether this layer still carries a contact, in O(1).
     *
     * Mirror of `flights.hasContact`: presence consumers must not infer absence
     * from the capped `getAllPositions` rows. Id matching follows trackById —
     * exact key first, then lowercase.
     * A disabled layer keeps its records but hides the collection, so it must
     * decline rather than answer from data the user can no longer see.
     * @param {string} icao24 Contact identifier.
     * @returns {boolean|null} Presence, or null when the layer is disabled or
     *   holds no data and therefore cannot answer.
     */
    hasContact(icao24) {
      if (
        !flightState._billboardCollection ||
        !flightState._billboardCollection.show ||
        flightState._billboards.size === 0
      )
        return null;
      if (!icao24) return false;
      const id = String(icao24).trim();
      return (
        flightState._billboards.has(id) ||
        flightState._billboards.has(id.toLowerCase())
      );
    },

    getAllPositions(maxCount = 500) {
      if (
        !flightState._billboardCollection ||
        flightState._billboards.size === 0
      )
        return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;

      const result = [];
      for (const [icao24, bb] of flightState._billboards) {
        const pos = bb.position;
        if (!pos) continue;
        const carto = Cesium.Cartographic.fromCartesian(
          pos,
          Cesium.Ellipsoid.WGS84,
          flightState._scratchCarto,
        );
        if (!carto) continue;
        const info = flightState.records.data.get(icao24);
        result.push({
          id: icao24, // identity (trackById/Context resolve this)
          // Last surface still reading as the raw hex for a callsign-less
          // contact — same chain as getNearby/getDetectableObjects/getTrackedSubject.
          label:
            _toCleanText(info?.callsign) ||
            _toCleanText(info?.registration) ||
            icao24,
          position: pos,
          latitude: Cesium.Math.toDegrees(carto.latitude),
          longitude: Cesium.Math.toDegrees(carto.longitude),
          altitudeM: carto.height,
        });
        if (result.length >= limit) break;
      }
      return result;
    },

    /**
     * Snapshot the layer's in-memory records as plain JSON-safe objects for
     * the analyst query engine. On-demand only (called at most once per
     * spoken query) — zero per-frame cost, no listeners, no caching. Returns
     * [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (
        !flightState._billboardCollection ||
        !flightState._billboardCollection.show ||
        flightState.records.data.size === 0
      )
        return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const [icao24, info] of flightState.records.data) {
        result.push(mapAnalystRecord(icao24, info));
        if (result.length >= limit) break;
      }
      return result;
    },

    /**
     * Start camera-tracking an aircraft by ICAO hex identifier.
     * @param {string} icao24 - ICAO hex identifier of the aircraft.
     * @returns {boolean} True if the aircraft exists and tracking started.
     */
    trackById(icao24, { origin = 'programmatic' } = {}) {
      if (!icao24) return false;
      let id = String(icao24).trim();
      if (!flightState._billboards.has(id)) id = id.toLowerCase();
      if (!flightState._billboards.has(id)) return false;
      if (parts.tracking._isExplicitTrackingOrigin(origin))
        parts.tracking._cancelPendingTrackingRestore();
      if (flightState._trackedIcao === id)
        return parts.tracking._publishTrackedSelection(id, origin);
      parts.tracking._trackFlight(id, { origin });
      return true;
    },

    /** Resolve a shared Follow target only against the latest accepted refresh. */
    async resolveTrackingRestoreTarget(
      icao24,
      { signal = null, origin = 'share-restore' } = {},
    ) {
      if (signal?.aborted)
        return {
          status: 'cancelled',
          reason: String(signal.reason || 'aborted'),
        };
      const id = String(icao24 ?? '')
        .trim()
        .toLowerCase();
      if (!id) return { status: 'missing', reason: 'invalid-target' };
      const outcome = flightState.feed._lastTrackingRefreshOutcome;
      if (outcome.status !== 'accepted') {
        return {
          status: 'source-unavailable',
          reason: `${flightState.feed._lastSource} snapshot unavailable`,
          refreshEpoch: outcome.epoch,
          source: outcome.source,
        };
      }
      if (!outcome.ids.has(id)) {
        return {
          status: 'missing',
          reason: 'target-absent-from-snapshot',
          refreshEpoch: outcome.epoch,
          source: outcome.source,
        };
      }
      if (signal?.aborted)
        return {
          status: 'cancelled',
          reason: String(signal.reason || 'aborted'),
        };
      const followed = this.trackById(id, { origin });
      return followed
        ? {
            status: 'found',
            refreshEpoch: outcome.epoch,
            source: outcome.source,
          }
        : {
            status: 'source-unavailable',
            reason: 'target-not-renderable',
            refreshEpoch: outcome.epoch,
          };
    },

    /** Reapply the canonical follow frame without recreating the selected flight. */
    refocusTrackedById(icao24, { origin = 'programmatic' } = {}) {
      if (
        !icao24 ||
        flightState._cockpitContactMode ||
        !flightState._viewer ||
        !flightState._trackedEntity
      )
        return false;
      let id = String(icao24).trim();
      if (!flightState._billboards.has(id)) id = id.toLowerCase();
      if (
        id !== flightState._trackedIcao ||
        !flightState._viewer.entities?.contains?.(flightState._trackedEntity) ||
        flightState._viewer.trackedEntity !== flightState._trackedEntity
      )
        return false;
      flightState._trackedCameraFrameStop?.();
      flightState._viewer.camera.cancelFlight();
      flightState._viewer.trackedEntity = flightState._trackedEntity;
      flightState._trackedCameraFrameStop =
        applyTrackedCameraFrame(
          flightState._viewer,
          flightState._trackedEntity,
          flightState._trackedEntity.viewFrom,
        ) || null;
      parts.tracking._publishTrackedSelection(id, origin);
      return true;
    },

    /**
     * Stop tracking the currently followed aircraft (no-op if none).
     * @returns {boolean} Always true.
     */
    stopTracking({ origin = 'programmatic' } = {}) {
      parts.tracking._cancelPendingTrackingRestore();
      parts.tracking._clearTracking(false, { origin });
      return true;
    },

    cancelPendingTrackingRestore() {
      parts.tracking._cancelPendingTrackingRestore();
    },

    /**
     * Describe the currently tracked aircraft at its dead-reckoned position.
     * @returns {{icao24: string, callsign: string|null, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null, verticalRateMps: number|null}|null}
     *   Tracked aircraft info, or null when nothing is tracked.
     */
    getTrackedInfo() {
      if (!flightState._trackedIcao) return null;
      const described = _describeFlight(flightState._trackedIcao);
      if (!described) return null;
      const { position, ...rest } = described;
      return rest;
    },

    /**
     * Return the current aircraft as a Context subject without changing
     * tracking or camera ownership.
     * @returns {{layerId: string, id: string, label: string, position: Cesium.Cartesian3}|null}
     *   Detached subject descriptor, or null when no aircraft is tracked.
     */
    getTrackedSubject() {
      if (!flightState._trackedIcao) return null;
      const described = _describeFlight(flightState._trackedIcao);
      if (!described?.position) return null;
      return {
        layerId: 'military',
        id: described.icao24,
        // Same label chain as getNearby/getDetectableObjects: a callsign-less
        // contact reads as its registration, never as the raw ICAO hex.
        label: described.callsign || described.registration || described.icao24,
        position: Cesium.Cartesian3.clone(described.position),
      };
    },

    /**
     * Return current layer health/status for the HUD status chip.
     * @returns {{count: number, lastUpdate: number|null, stale: boolean, error: string|null, status: number|null, retryInSec: number}}
     */
    getStats() {
      const retryInSec = flightState.feed._retryAt
        ? Math.max(
            0,
            Math.ceil((flightState.feed._retryAt - Date.now()) / 1000),
          )
        : 0;
      return {
        count: flightState.feed._count,
        lastUpdate: flightState.feed._lastUpdate,
        stale: flightState.feed._backoff,
        error: flightState.feed._lastError,
        status: flightState.feed._lastStatus,
        retryInSec,
        source: flightState.feed._lastSource,
        fallback: false,
      };
    },
  };

  return {
    _toFiniteNumber,
    _toCleanText,
    _formatAltitude,
    _likelyLanded,
    _describeFlight,
    _normalizeTrackedIcao,
    mapAnalystRecord,
    methods,
  };
}
