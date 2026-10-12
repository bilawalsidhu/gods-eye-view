import { approxDistanceKm as _approxDistanceKm } from './recordPolicy.js';
import { displayedKinematics } from '../../data/motionModel.js';
import * as Cesium from 'cesium';
import { isExplicitLayerStateOrigin } from '../../data/layerState.js';
import { modelVisualAnchor } from '../../data/modelVisualAnchor.js';
import {
  rankContactMatch,
  contactMatchWins,
  CONTACT_MATCH_TIER,
} from '../../data/contactMatch.js';
import { aircraftIncludedInNearby } from '../../data/aircraftNearbyPolicy.js';
import {
  LANDED_ALT_MAX_M,
  LANDED_SPEED_MAX_MPS,
  FOCUS_EVIDENCE_DEV,
  FLEET_DR_INTERVAL_MS,
} from './policy.js';

export function createQueries({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { tr3bTypeLabel, tr3bAircraftClass } = services.aircraftPresentation;
  const { formatFlightLevel } = services.labels;
  const { isMilitaryIcao } = services.militaryRegistry;
  const { applyTrackedCameraFrame } = services.camera;
  const {
    setFocusDeemphasisParams,
    getFocusDeemphasisParams,
    setFocusEvidenceNowMs,
    advanceFocusEvidenceNowMs,
  } = services.focus;
  const { setAircraftRecessionParams, getAircraftRecessionParams } =
    services.recession;

  /**
   * Cheap equirectangular distance (km) — plenty accurate for the ~150 km
   * ground-floor clamp gate; runs once per contact per poll, so no trig-heavy
   * haversine needed.
   * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
   * @returns {number} Approximate great-circle distance in km.
   */

  /**
   * True when the aircraft's latest metadata reads "on or about the runway"
   * (low + slow) — see the landed fast-cull rationale above. Both gates must
   * hold, so a plane missing either datum keeps the normal grace.
   * @param {string} icao24 - ICAO 24-bit transponder address.
   * @returns {boolean}
   */

  function _likelyLanded(icao24) {
    const info = flightState.records.data.get(icao24);
    if (!info) return false;
    // Round 7 (owner: "fewer planes than OpenSky's own map" + "parked planes
    // never heal"): the fast cull only applies to contacts that were AIRBORNE
    // this session — its original target, the post-LANDING ghost. OpenSky's
    // ground coverage flaps constantly, so fast-culling every grounded contact
    // put parked planes in an evict/re-enter churn: each re-entry was a
    // brand-new contact with cold floor state (geoid-height first poll), so
    // the apron looked half-empty AND perpetually sunken. First-seen-grounded
    // contacts now ride the normal MISSING_POLL_LIMIT grace and keep their
    // identity (and warmed floors) across feed flaps.
    if (info.wasAirborne !== true) return false;
    // Was airborne, then grounded, then VANISHED from the poll — landed ghost.
    if (info.onGround) return true;
    return (
      Number.isFinite(info.altitude) &&
      info.altitude < LANDED_ALT_MAX_M &&
      Number.isFinite(info.velocity) &&
      info.velocity < LANDED_SPEED_MAX_MPS
    );
  }

  /**
   * Normalize a value to a trimmed string. A whitespace-only field ("   ") is
   * truthy, so every label chain must trim FIRST and then fall through.
   * @param {*} value - Any value (typically a metadata string or null).
   * @returns {string} Trimmed string, or '' if falsy.
   */

  function _toCleanText(value) {
    return String(value || '').trim();
  }

  /**
   * The layer's ONE label convention: spoken callsign → tail registration → raw
   * ICAO hex. Mirrors militaryFlights.js so the same aircraft reads identically
   * in both layers.
   *
   * Registration is aircraft IDENTITY, not route, so unlike the origin/destination
   * line it is NOT plausibility-gated — an adsbdb tail number describes the
   * airframe itself and cannot go stale the way a leg can.
   *
   * This is a DISPLAY string only. Identity everywhere in this layer is `icao24`
   * (the `_billboards`/`_flightData` key, the `sourceId` detection declutter hashes,
   * the `id` that trackById/Context cohorts resolve) — never the label.
   * @param {string} icao24 - ICAO 24-bit transponder address (the identity key).
   * @param {Object|null|undefined} info - `_flightData` record for this aircraft.
   * @returns {string} Display label; never empty.
   */

  function _contactLabel(icao24, info) {
    return (
      _toCleanText(info?.callsign) || _toCleanText(info?.registration) || icao24
    );
  }

  /**
   * Build a public descriptor for one aircraft using its best current position
   * (dead-reckoned when history exists, billboard position otherwise).
   * @param {string} icao24 - ICAO 24-bit transponder address.
   * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
   *   Descriptor with a cloned position, or null if the aircraft is unknown.
   */

  function _describeFlight(icao24) {
    // DATA, NOT PIXELS — deliberately UNFLOORED (2026-08-19). The display floor
    // lifts grounded contacts onto the visible mesh so the sprite you see is not
    // buried; that is a rendering correction, not a measurement. This descriptor
    // feeds query/analyst/subject APIs — `findByQuery` (voice track-by-name),
    // `getTrackedInfo` (cockpit + readout altitude), `getTrackedSubject`
    // (proximity counts and distances) — where the honest answer is what the
    // aircraft REPORTED, not where its icon was nudged to avoid clipping tiles.
    // `altitudeM` is therefore the barometric/aviation value and `renderAltitudeM`
    // the fix-time datum, neither of them the floored display height. No
    // user-visible surface renders `position` as the plane's on-screen location —
    // every visual consumer reads the floored per-frame cache instead (see
    // `_trackedDisplayPosition`). If that ever changes, floor this path too.
    const info = flightState.records.data.get(icao24);
    const bb = flightState._billboards.get(icao24);
    const basePos =
      parts.motion._deadReckon(icao24) || (bb ? bb.position : null);
    if (!basePos) return null;
    const displayed = displayedKinematics({
      derivedSpeedMps: flightState._drSpeedMps,
      derivedTrackDeg: flightState._drCourseDeg,
      reportedSpeedMps: info?.velocity,
      reportedTrackDeg: info?.true_track,
    });
    const carto = Cesium.Cartographic.fromCartesian(
      basePos,
      Cesium.Ellipsoid.WGS84,
      flightState._scratchCarto,
    );
    if (!carto) return null;
    return {
      icao24,
      callsign: String(info?.callsign || '').trim() || null,
      position: Cesium.Cartesian3.clone(basePos),
      latitude: Cesium.Math.toDegrees(carto.latitude),
      longitude: Cesium.Math.toDegrees(carto.longitude),
      // The cockpit instrument reports aviation altitude, not the Cesium
      // ellipsoid height of the camera/ground-clamped render position. The
      // latter can be slightly negative over terrain near the surface.
      altitudeM: Number.isFinite(info?.altitude) ? info.altitude : carto.height,
      renderAltitudeM: Number.isFinite(info?.renderAltitudeM)
        ? info.renderAltitudeM
        : carto.height,
      onGround: info?.onGround === true,
      velocityMps: displayed.speedMps,
      track: displayed.trackDeg,
      stale: Boolean(
        flightState.records.missingPolls.get(icao24) ||
        flightState.feed._backoff,
      ),
      airline: info?.airline ?? null,
      // CLASS label follows the TR-3B conversion so every downstream card
      // (cockpit, Contacts, analyst) agrees with the triangle on screen.
      typeName: tr3bTypeLabel(icao24, info?.typeName ?? null),
      typeCode: tr3bTypeLabel(icao24, info?.typeCode ?? null),
      // IDENTITY, deliberately NOT converted: registration is the airframe's tail
      // number and feeds `_contactLabel`'s callsign → registration → hex chain, so
      // a converted contact keeps the label convention every other contact uses.
      // Trimmed like `callsign` above so every consumer (cockpit readout, voice
      // narration, getTrackedSubject) can use it as a label link without
      // re-guarding a whitespace-only enrichment value.
      registration: _toCleanText(info?.registration) || null,
      origin:
        info?.route && parts.tracking._routeIsPlausible(icao24, info.route)
          ? info.route.origin.code
          : null,
      destination:
        info?.route && parts.tracking._routeIsPlausible(icao24, info.route)
          ? info.route.destination.code
          : null,
      route:
        info?.route && parts.tracking._routeIsPlausible(icao24, info.route)
          ? {
              origin: { ...info.route.origin },
              destination: { ...info.route.destination },
            }
          : null,
    };
  }

  function _normalizeTrackedIcao(candidate) {
    const normalized = String(candidate ?? '')
      .trim()
      .toLowerCase();
    return normalized || null;
  }

  /**
   * Map one aircraft's internal poll record to a plain JSON-safe analyst
   * record (analyst query engine seam). Pure — no Cesium types, no fetches;
   * enrichment fields read the CACHED adsbdb values only. Missing/unknown
   * fields are null, never NaN/undefined. The route-plausibility verdict is
   * computed by the CALLER (it needs the billboard position) and passed in,
   * so an implausible cached route is never surfaced as fact.
   * @param {string} icao24 - ICAO 24-bit transponder address.
   * @param {Object|null|undefined} info - `_flightData` record for this aircraft.
   * @param {{military?: boolean, routeOk?: boolean}} [flags] - Shared-registry
   *   military flag + route-plausibility verdict.
   * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
   *   lon: number|null, altitudeM: number|null, speedMps: number|null,
   *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
   *   military: boolean, aircraftClass: string|null, originCountry: string|null,
   *   operator: string|null, routeOrigin: string|null, routeDestination: string|null}}
   */

  function mapAnalystRecord(
    icao24,
    info,
    { military = false, routeOk = false } = {},
  ) {
    const num = (v) => (Number.isFinite(v) ? v : null);
    const text = (v) => {
      const t = String(v ?? '').trim();
      return t || null;
    };
    const callsign = text(info?.callsign);
    return {
      // Display identity for the narration layer. `id` is NOT a queryable field
      // (see ANALYST_LAYERS) and follow-ups carry whole records, so this is a
      // label, not a key — the engine keys on `icao24` below.
      id: callsign || text(info?.registration) || icao24,
      icao24,
      callsign,
      lat: num(info?.rawLat),
      lon: num(info?.rawLon),
      altitudeM: num(info?.altitude), // barometric/MSL — the aviation field, not the render height
      speedMps: num(info?.velocity),
      heading: num(info?.true_track),
      verticalRateMps: num(info?.verticalRate),
      onGround: info?.onGround === true,
      military,
      // A converted contact reports the class it RENDERS as, so an analyst
      // filter/superlative agrees with the triangle on screen.
      aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
      originCountry: text(info?.originCountry),
      operator: text(info?.airline),
      routeOrigin: routeOk ? text(info?.route?.origin?.code) : null,
      routeDestination: routeOk ? text(info?.route?.destination?.code) : null,
    };
  }
  const methods = {
    mapAnalystRecord,

    id: 'flights',

    name: 'Live Flights',

    icon: '✈️',

    source: flightState.feed._lastSource,

    // Browser-harness seam: isolates synthetic display-floor scenarios without
    // changing any production lifecycle or cache policy.
    _clearDisplayFloorStateForTest:
      parts.testing._clearDisplayFloorStateForTest,

    /** @type {number} Polling interval (ms) between update() calls */
    updateInterval: 30000,

    /**
     * Live layer params.
     * `models3d` toggles 3D glTF model rendering for the FLEET (altitude-gated): when on,
     * surrounding aircraft become 3D models once the camera is zoomed in past MODEL_ALT_CEIL_M.
     * The TRACKED contact is NOT gated by this — it takes its 3D model by camera distance
     * regardless (see `_trackedModelRegimeActive` / trackedModelRegime.js).
     * `models3dMode` is 'proximity' (nearest MODEL_MAX in view) or 'all' (every in-view plane).
     * @param {{models3d?: boolean, models3dMode?: 'proximity'|'all', selectedFlightsTrackingId?: string|null}} params
     */
    setParams(params = {}, { origin = 'programmatic' } = {}) {
      if (
        isExplicitLayerStateOrigin(origin) &&
        !Object.hasOwn(params, 'selectedFlightsTrackingId')
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
          // Restore fleet billboards (the horizon-cull pass re-asserts next tick), but NEVER the
          // tracked plane's own fleet billboard — its tracked entity is the visual, so re-showing it
          // here would double-image the tracked plane when 3D is turned off mid-track.
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
        // cold and thermal-reactive variants directly. Bounded by the operator's
        // own conversions, so this never touches the ordinary fleet.
        parts.tracking._refreshTr3bForStyle();
      }
      if (Object.hasOwn(params, 'selectedFlightsTrackingId')) {
        const requested = _normalizeTrackedIcao(
          params.selectedFlightsTrackingId,
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
        selectedFlightsTrackingId: flightState._trackedIcao,
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
     * Return a subsample of currently visible aircraft for detection overlay
     * rendering (e.g. bounding boxes drawn on-screen by the CCTV detection layer).
     *
     * Uses a deterministic stride + seed to select a spatially distributed
     * subset without sorting or shuffling.
     *
     * @param {object}  [options]
     * @param {number}  [options.maxCount] - Maximum number of objects to return.
     * @param {number}  [options.seed]     - Deterministic offset into the stride pattern.
     * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean}>}
     */
    getDetectableObjects(options = {}) {
      if (
        !flightState._billboardCollection ||
        !flightState._billboardCollection.show
      )
        return [];
      // Compute a stride that evenly samples the billboard map.
      // seed shifts the starting offset so successive calls can sample
      // different aircraft without shuffling the underlying Map order.
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : flightState._billboards.size;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
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
        let object = flightState._detectionObjects.get(icao24);
        if (!object) {
          object = {
            sourceId: icao24,
            type: 'AIR',
            _weldPos: new Cesium.Cartesian3(),
          };
          flightState._detectionObjects.set(icao24, object);
        }
        // WELD: anchor to whatever actually owns the visual. A model-owned contact is
        // read straight off the translation the fleet tick already wrote into its
        // modelMatrix, so bracket and label sit on the aircraft you can see instead of
        // on the buried billboard position, which for a grounded plane is ~100 m below
        // and rises only as the coarse ground-floor cell warms. Zero extra sampling and
        // no `_modelDisplayPosition` call from postRender. Sprite-owned contacts keep
        // `bb.position` — sprite and bracket are co-located there, so association holds.
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
        // Card text only — declutter/cohort identity is `object.sourceId` (icao24).
        const id = _contactLabel(icao24, info);
        if (object.id !== id) object.id = id;
        const altitude = info?.altitude;
        if (object._altitude !== altitude) {
          object._altitude = altitude;
          object.metric = formatFlightLevel(altitude); // altitude is metres
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
     * @param {string} query - ICAO24 hex or full/partial callsign.
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
      // very identity the app had just shown. Ranking is shared with the
      // military layer (contactMatch.js) so the two cannot disagree, and it is
      // strictly tiered so a registration can never out-rank a real callsign on
      // feed order alone.
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
     * Find aircraft near a given ECEF position, sorted ascending by distance.
     * Return shape mirrors militaryFlightsLayer.getNearby (id/icao24/position/distance).
     * @param {Cesium.Cartesian3} center - Reference position in ECEF coordinates.
     * @param {number} range - Maximum distance in meters (Infinity if not finite).
     * @param {number} [maxCount=50] - Maximum number of results to return.
     * @param {object} [options] Query membership options.
     * @param {boolean} [options.includeHidden=false] Include loaded horizon-hidden aircraft.
     * @returns {Array<{id: string, icao24: string, callsign: string|null, position: Cesium.Cartesian3, distance: number, aircraftClass: string|null, altitudeM: number|null, velocityMps: number|null, track: number|null}>}
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
        const callsign = info?.callsign?.trim() || null;
        nearby.push({
          // Label. Callers that need identity read `icao24` (Context cohorts do).
          id: _contactLabel(icao24, info),
          icao24,
          callsign,
          position: pos,
          distance,
          // Filter surface: the cockpit next/previous path matches on THIS field
          // (militaryAwareness.aircraftClassMatchesFilter), so a converted contact
          // has to report the class it renders as or a `tr3b` filter skips it.
          aircraftClass: tr3bAircraftClass(
            icao24,
            String(info?.klass || '')
              .trim()
              .toLowerCase() || null,
          ),
          altitudeM: info?.altitude ?? null,
          velocityMps: info?.velocity ?? null,
          track: info?.true_track ?? null,
        });
      }

      nearby.sort((a, b) => a.distance - b.distance);
      return nearby.slice(0, limit);
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
     * Presence consumers must not infer absence from `getAllPositions`: it stops
     * at its cap, and this layer routinely carries ~11k contacts against a
     * 1,000-row cap, so "not in the returned rows" is not "gone". Id matching
     * mirrors trackById: exact key first, then lowercase.
     * A disabled layer keeps its records but hides the collection, so it must
     * decline rather than answer from data the user can no longer see —
     * otherwise a preserved subject reads as fresh off stale hidden state.
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
          id: icao24, // identity (trackById resolves this)
          label: _contactLabel(icao24, info),
          position: pos,
          latitude: Cesium.Math.toDegrees(carto.latitude),
          longitude: Cesium.Math.toDegrees(carto.longitude),
          altitudeM: carto.height,
          airline: info?.airline ?? null,
          typeName: info?.typeName ?? null,
          typeCode: info?.typeCode ?? null,
          registration: info?.registration ?? null,
          origin:
            info?.route && parts.tracking._routeIsPlausible(icao24, info.route)
              ? info.route.origin.code
              : null,
          destination:
            info?.route && parts.tracking._routeIsPlausible(icao24, info.route)
              ? info.route.destination.code
              : null,
        });
        if (result.length >= limit) break;
      }
      return result;
    },

    /**
     * Snapshot the layer's in-memory records as plain JSON-safe objects for
     * the analyst query engine. On-demand only (called at most once per
     * spoken query) — zero per-frame cost, no listeners, no caching, no
     * enrichment fetches (cached adsbdb values only). Returns [] while the
     * layer is disabled or empty.
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
        const routeOk =
          !!info?.route && parts.tracking._routeIsPlausible(icao24, info.route);
        result.push(
          mapAnalystRecord(icao24, info, {
            military: isMilitaryIcao(icao24),
            routeOk,
          }),
        );
        if (result.length >= limit) break;
      }
      return result;
    },

    /**
     * Start camera-tracking an aircraft by ICAO24 address.
     * @param {string} icao24 - ICAO 24-bit transponder address.
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
      const id = _normalizeTrackedIcao(icao24);
      if (!id) return { status: 'missing', reason: 'invalid-target' };
      const outcome = flightState.feed._lastTrackingRefreshOutcome;
      if (outcome.status !== 'accepted') {
        return {
          status: 'source-unavailable',
          reason: 'OpenSky snapshot unavailable',
          refreshEpoch: outcome.epoch,
          source: outcome.source,
          coverage: outcome.coverage,
        };
      }
      if (!outcome.ids.has(id)) {
        return {
          status: 'missing',
          reason: 'target-absent-from-snapshot',
          refreshEpoch: outcome.epoch,
          source: outcome.source,
          coverage: outcome.coverage,
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
            coverage: outcome.coverage,
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
     * @returns {{icao24: string, callsign: string|null, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
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
        layerId: 'flights',
        id: described.icao24,
        // Same label chain as getNearby/getDetectableObjects: a callsign-less
        // contact reads as its registration, never as the raw ICAO hex.
        label:
          described.callsign ||
          _toCleanText(described.registration) ||
          described.icao24,
        position: Cesium.Cartesian3.clone(described.position),
      };
    },

    ...(FOCUS_EVIDENCE_DEV
      ? {
          __focusEvidence: Object.freeze({
            setAircraft: parts.evidence._setFocusEvidenceAircraft,
            moveAircraft: parts.evidence._moveFocusEvidenceAircraft,
            snapshot: parts.evidence._focusEvidenceSnapshot,
            setTuning({ focus = {}, horizon = {} } = {}) {
              return {
                focus: setFocusDeemphasisParams(focus),
                horizon: setAircraftRecessionParams(horizon),
              };
            },
            getTuning() {
              return {
                focus: { ...getFocusDeemphasisParams() },
                horizon: { ...getAircraftRecessionParams() },
              };
            },
            takeFrameClock(startMs = 1_000_000_000) {
              if (!flightState._viewer || !Number.isFinite(startMs))
                return { ok: false, nowMs: null };
              flightState._viewer.useDefaultRenderLoop = false;
              setFocusEvidenceNowMs(startMs);
              flightState._lastFleetTickMs = startMs - FLEET_DR_INTERVAL_MS;
              // Cross a browser task boundary, then close Cesium's pending-loop
              // latch. Any already-queued callback still observes the false gate,
              // while manual evidence renders can begin without waiting on VSYNC.
              return new Promise((resolve) =>
                setTimeout(() => {
                  if (flightState._viewer?._cesiumWidget)
                    flightState._viewer._cesiumWidget._renderLoopRunning = false;
                  resolve({ ok: true, nowMs: startMs });
                }, 0),
              );
            },
            advanceFrameClock(deltaMs = FLEET_DR_INTERVAL_MS) {
              return advanceFocusEvidenceNowMs(deltaMs);
            },
            releaseFrameClock() {
              setFocusEvidenceNowMs(null);
              if (flightState._viewer)
                flightState._viewer.useDefaultRenderLoop = true;
            },
          }),
        }
      : {}),

    /**
     * Return layer health/status for the HUD stats chip.
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
        coverage: flightState.feed._lastCoverage,
      };
    },
  };

  return {
    _approxDistanceKm,
    _likelyLanded,
    _toCleanText,
    _contactLabel,
    _describeFlight,
    _normalizeTrackedIcao,
    mapAnalystRecord,
    methods,
  };
}
