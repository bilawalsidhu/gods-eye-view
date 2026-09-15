import {
  SUPPORT_KEYS,
  planeSupportPoints,
  poseHash,
} from '../../data/cctvFootprint.js';

/** Cooldown before a provisional (geoid-fallback / partial) footprint is retried. */
const FOOTPRINT_RETRY_MS = 60_000;

export function createGround({ state: layerState, services, parts, source }) {
  const { resolveGroundFloorCells } = services.ground;
  const { resolveEllipsoidalGround } = services.terrain;

  /**
   * Task 5 (height-datum fix): maps the scene's `globe.show` flag to the surface
   * regime key the per-camera ground cache is keyed by (spec §2 "cache by
   * surface regime", collapsed to two keys — ion World Terrain and Re:Earth
   * globe terrain get the same handling):
   *
   *  - `google-3d`     — photoreal stack: globe hidden, the visible Google 3D
   *                      tileset IS the surface → one-shot scene sampling refines.
   *  - `terrain-globe` — any globe stack: the Re:Earth point-height prior IS the
   *                      resolution (zero scene queries).
   *
   * Only an explicit `false` (the photoreal stack hides the globe) selects
   * `google-3d`; undefined/null (no viewer / torn down) must fall to the regime
   * that never touches the scene. Pure — exported for the unit suite.
   * @param {boolean|undefined|null} globeShow - `viewer.scene.globe.show`.
   * @returns {'google-3d'|'terrain-globe'}
   */

  function surfaceRegimeKey(globeShow) {
    return globeShow === false ? 'google-3d' : 'terrain-globe';
  }

  /**
   * Task 5: the surface regime the scene is CURRENTLY rendering, derived live
   * from `globe.show` (mapStackController's `_activatePhotoreal` /
   * `_activateGlobeStack` flip exactly this flag). Reading scene state directly
   * — rather than caching the map-stack id — means the regime is correct even
   * for stack changes this module never got an event for.
   * @returns {'google-3d'|'terrain-globe'}
   */

  function currentSurfaceRegime() {
    return surfaceRegimeKey(layerState._viewer?.scene?.globe?.show);
  }

  /**
   * Task 5: the record's ellipsoidal ground PRIOR (Re:Earth point-height batch,
   * `record.groundPrior.ellipsoid`), falling back to the catalog's fabricated
   * orthometric `groundElevationM` only when the prior batch hasn't landed yet.
   * This is the value that replaces every previous
   * `Number(camera.groundElevationM) || 0` ground fallback — it alone lifts
   * London's cameras from the fabricated 15 m to ~52.7 m ellipsoidal in every
   * regime, on first paint.
   * @param {Object} record - Camera record.
   * @returns {number} Ellipsoidal ground altitude in metres.
   */

  function groundPriorAltFor(record) {
    const prior = record?.groundPrior?.ellipsoid;
    return Number.isFinite(prior)
      ? prior
      : Number(record?.camera?.groundElevationM) || 0;
  }

  /**
   * Task 5: whether the record's one-shot ground resolution has completed for
   * the given regime (per-regime latch — replaces the old boolean
   * `groundResolved`).
   * @param {Object} record - Camera record.
   * @param {string} [regime] - Defaults to the current surface regime.
   * @returns {boolean}
   */

  function isGroundResolved(record, regime = currentSurfaceRegime()) {
    return record?.groundResolved?.[regime] === true;
  }

  /**
   * Ground altitude used for pure geometry recomputes: the given regime's
   * cached resolution (`record.groundSamples[regime]` — a shared mesh/DEM floor
   * in google-3d, the DEM/prior in terrain-globe) when it exists, else the prior
   * itself. Never queries the scene.
   * @param {Object} record - Camera record.
   * @param {string} [regime] - Defaults to the current surface regime.
   * @returns {number} Ground altitude in metres.
   */

  function groundAltFor(record, regime = currentSurfaceRegime()) {
    const cached = record?.groundSamples?.[regime];
    return Number.isFinite(cached) ? cached : groundPriorAltFor(record);
  }

  /**
   * Re-arms a record for a fresh one-shot ground resolution after a GENUINE
   * pose change (an explicit user select/move or manual calibration edit).
   * Clears the CURRENT regime's resolved latch so the next real pass in
   * updateRecordGeometry always applies, then the record re-freezes. Never
   * called on a timer.
   *
   * The cached `groundSamples` entries are deliberately KEPT (only the latch is
   * cleared). They are the record's "has ever resolved" memory: the B9c
   * fallback guard in updateRecordGeometry reads the google-3d entry so a
   * rearmed camera whose tiles are mid-stream (e.g. select → flyTo →
   * tilesLoaded false) is not yanked back to prior/catalog heights before its
   * fresh shared floor lands. In the terrain-globe regime the re-arm is
   * effectively free: the next pass re-latches from the DEM/prior with zero
   * scene queries.
   * @param {Object} record - Camera record.
   */

  function rearmGroundResolution(record) {
    if (!record) return;
    record.groundResolved[currentSurfaceRegime()] = false;
  }

  /**
   * Resolves a user-moved ground anchor exactly once at commit. The synchronous
   * pass uses a warm shared floor immediately, or preserves the pre-drag floor
   * while the new cell is cold. A revision and coordinate check prevent an
   * older asynchronous release from rewriting a newer edit.
   * @param {Object} record - Camera record whose lat/lon just committed.
   */

  function resolveCommittedGroundAnchor(record) {
    if (!record?.camera) return;
    record.calibrationGroundResolveCount =
      (record.calibrationGroundResolveCount || 0) + 1;
    const revision = (record.calibrationGroundRevision || 0) + 1;
    record.calibrationGroundRevision = revision;
    const point = { lat: record.camera.lat, lon: record.camera.lon };

    rearmGroundResolution(record);
    parts.geometry.updateRecordGeometry(record);
    if (isGroundResolved(record)) return;

    resolveGroundFloorCells([point]).then(() => {
      if (layerState._recordById.get(record.camera.id) !== record) return;
      if (record.calibrationGroundRevision !== revision) return;
      if (record.camera.lat !== point.lat || record.camera.lon !== point.lon)
        return;
      rearmGroundResolution(record);
      parts.geometry.updateRecordGeometry(record);
      parts.rendering.refreshCoverageStyles();
      parts.presentation.notifyListeners();
    });
  }

  /**
   * Task 5: batches every catalog camera's coords through the Re:Earth
   * ellipsoidal ground resolver (`/api/terrain/heights` proxy — network-cached,
   * chunked, geoid fallback; NOT a scene query). The catalog's orthometric
   * `groundElevationM` rides along as `sourceOrthometricM` so the geoid
   * fallback chain is meaningful where the catalog value is real (Caltrans).
   * Never rejects — a total failure resolves null and geometry stays on
   * catalog fallbacks (no worse than pre-Task-5).
   * @param {Object[]} catalog - Camera objects (post-ensureCameraPose).
   * @returns {Promise<Array<{ellipsoid:number, source:string}>|null>}
   */

  async function resolveGroundPriors(catalog) {
    try {
      const coords = catalog.map((camera) => {
        const ortho = Number(camera.groundElevationM);
        return {
          lat: camera.lat,
          lon: camera.lon,
          ...(Number.isFinite(ortho) ? { sourceOrthometricM: ortho } : {}),
        };
      });
      return await resolveEllipsoidalGround(coords);
    } catch (error) {
      console.warn(
        '[Data:CCTV] ground-prior batch failed (keeping catalog fallbacks):',
        error?.message || error,
      );
      return null;
    }
  }

  /**
   * Task 5: applies a LATE-arriving ground-prior batch (init's bounded race
   * lost — cold proxy cache / slow upstream). Pure recomputes only, no scene
   * queries:
   *  - terrain-globe regime: the prior IS the resolution → re-run the
   *    resolution (updateRecordGeometry latches it) for every record.
   *  - google-3d regime: records still awaiting a shared floor move from the
   *    catalog fallback onto the exact prior; records already holding a shared
   *    mesh/DEM floor keep it untouched.
   * Guarded per record against a torn-down/re-inited layer (records are only
   * touched while they are still the live catalog entries).
   * @param {Object[]} records - The record array captured at init time.
   * @param {Array<{ellipsoid:number, source:string}>} priors - Aligned by index.
   */

  function applyLateGroundPriors(records, priors) {
    if (!Array.isArray(records) || !Array.isArray(priors)) return;
    let applied = 0;
    for (let i = 0; i < records.length && i < priors.length; i++) {
      const record = records[i];
      const prior = priors[i];
      if (!record || !prior || !Number.isFinite(prior.ellipsoid)) continue;
      // Stale-record guard: init() may have re-run (destroy/init cycle) while
      // the batch was in flight — only touch records still live in the map.
      if (layerState._recordById.get(record.camera.id) !== record) continue;
      record.groundPrior = prior;
      // Keep the cheap pre-enable altitude consistent for records whose
      // geometry hasn't been applied yet (applyFrustumGeometry overwrites it).
      if (!record.frustumPositions) {
        record.camera.absoluteHeightM =
          prior.ellipsoid + record.camera.mountHeightM;
      }
      const regime = currentSurfaceRegime();
      if (regime === 'terrain-globe') {
        // Prior IS the resolution — re-latch onto the fresh value.
        parts.geometry.updateRecordGeometry(record, { sampleGround: false });
        applied += 1;
      } else if (!Number.isFinite(record.groundSamples['google-3d'])) {
        // Still awaiting the shared floor: snap interim geometry onto the exact
        // prior (pure recompute; the shared cell may refine later).
        parts.geometry.applyFrustumGeometry(record, prior.ellipsoid);
        applied += 1;
      }
    }
    if (applied) parts.presentation.notifyListeners();
  }

  /**
   * Task 5: surface-regime change handler ('gev:map-stack-changed'
   * CustomEvent, dispatched by main.js from MapStackController.onChange). The
   * surface HEIGHT at a camera differs between regimes (a photogrammetric
   * deck/building-top in google-3d vs bare Re:Earth DEM on globe stacks), so
   * on a REGIME change (photoreal ↔ globe; bing→osm stays 'terrain-globe' and
   * no-ops):
   *  1. every record's geometry recomputes IMMEDIATELY from the new regime's
   *     resolution — cached sample if that regime has one, else the Re:Earth
   *     prior (never blank, zero scene queries);
   *  2. entering google-3d re-arms the one-shot tiles-ready completion latch so
   *     update()'s existing event-driven machinery refines records that never
   *     took their sample, through the same staggered queue.
   * Event-driven only — never called on a timer.
   */

  function handleMapStackChanged() {
    if (!layerState._viewer || !layerState._records.length) return;
    const regime = currentSurfaceRegime();
    if (regime === layerState._lastAppliedRegime) return;
    layerState._lastAppliedRegime = regime;

    for (const record of layerState._records) {
      if (regime === 'terrain-globe') {
        // Prior IS the resolution — latch it (zero scene queries).
        record.groundSamples['terrain-globe'] = groundPriorAltFor(record);
        record.groundResolved['terrain-globe'] = true;
      }
      const ground = groundAltFor(record, regime);
      // Skip the entity rewrite when the applied ground already matches (e.g.
      // entering google-3d before any sample: prior → prior is a no-op) —
      // unless the record has a footprint source, whose eligibility depends
      // on the regime (shipped mesh samples apply in google-3d only).
      const hasFootprintSource =
        !!record.camera?.groundHeights || !!record.footprintGround;
      if (
        !hasFootprintSource &&
        record.frustumGeometry &&
        Math.abs(record.frustumGeometry.groundAltM - ground) < 0.001
      ) {
        continue;
      }
      parts.geometry.applyFrustumGeometry(record, ground);
    }

    if (regime === 'google-3d') {
      // Fresh google-3d session: let update()'s ONE-SHOT completion pass
      // re-enqueue records without an accepted sample once the (re-shown)
      // tileset reports tilesLoaded. Records already sampled in a previous
      // google-3d session keep their cached resolution — 0 new samples, well
      // under the ≤1-per-(camera, session) ceiling.
      layerState._tilesReadyReenqueued = false;
    }
    // The active camera may have just lost its shipped footprint (globe
    // regime) — resolve its DEM footprint for the new surface.
    const active = layerState._recordById.get(layerState._activeCameraId);
    if (active) void resolveFootprintGround(active);
    parts.presentation.notifyListeners();
  }
  /**
   * Resolves the ground under the monitor plane's nine support points for the
   * record's CURRENT pose from the Re:Earth DEM (network-cached proxy, never a
   * scene query), then re-applies the geometry so the rigid lift accounts for
   * terrain rising under the plane's far edge. This is the fallback for
   * cameras without a shipped precompute for this pose (a new pack, or a
   * camera the user has edited), and it runs only on demand: activation and
   * calibration commit. A late result for a stale pose or a torn-down record
   * is dropped. Never rejects.
   * @param {Object} record - Camera record.
   * @returns {Promise<void>}
   */
  async function resolveFootprintGround(record) {
    if (!record?.camera) return;
    const pose = parts.geometry.footprintPose(record);
    const hash = poseHash(pose);
    const existing = record.footprintGround;
    if (existing?.poseHash === hash) {
      // Complete real-DEM results are final; a geoid-fallback (proxy outage)
      // or partial result is retried after a cooldown.
      if (!existing.provisional || Date.now() < existing.retryAt) return;
    }
    if (parts.geometry.hasShippedFootprint(record)) return;
    const revision = (record.footprintRevision || 0) + 1;
    record.footprintRevision = revision;
    const { supports } = planeSupportPoints(pose);
    const coords = SUPPORT_KEYS.map((key) => ({
      lat: supports[key].lat,
      lon: supports[key].lon,
    }));
    let results = null;
    try {
      results = await resolveEllipsoidalGround(coords);
    } catch {
      results = null;
    }
    if (!Array.isArray(results)) return;
    if (record.footprintRevision !== revision) return;
    if (layerState._recordById.get(record.camera.id) !== record) return;
    if (poseHash(parts.geometry.footprintPose(record)) !== hash) return;
    const under = {};
    let real = 0;
    results.forEach((result, index) => {
      if (Number.isFinite(result?.ellipsoid)) {
        under[SUPPORT_KEYS[index]] = result.ellipsoid;
        if (result.source === 'reearth') real += 1;
      }
    });
    const provisional = real < SUPPORT_KEYS.length;
    record.footprintGround = {
      poseHash: hash,
      supports: under,
      source: provisional ? 'dem-provisional' : 'dem',
      provisional,
      retryAt: provisional ? Date.now() + FOOTPRINT_RETRY_MS : 0,
    };
    parts.geometry.applyFrustumGeometry(record, groundAltFor(record));
    parts.rendering.refreshCoverageStyles();
    parts.presentation.notifyListeners();
  }

  return {
    surfaceRegimeKey,
    currentSurfaceRegime,
    resolveFootprintGround,
    groundPriorAltFor,
    isGroundResolved,
    groundAltFor,
    rearmGroundResolution,
    resolveCommittedGroundAnchor,
    resolveGroundPriors,
    applyLateGroundPriors,
    handleMapStackChanged,
  };
}
