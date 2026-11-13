import { fromDegrees } from '../../geo/ellipsoid.js';
import { eastNorthUp, frameVector } from '../../geo/frames.js';
import { distance, vec } from '../../geo/vector.js';
import {
  FRUSTUM_GROUND_CLEARANCE_M,
  PROBE_MIN_RANGE_M,
  PROBE_CLEARANCE_M,
  COVERAGE_NEIGHBOR_RADIUS_KM,
  COVERAGE_NEIGHBOR_LIMIT,
  PLANE_FOOTPRINT_LIFT_CAP_M,
} from './policy.js';

import {
  planeDimensions,
  poseHash,
  requiredPlaneLift,
} from '../../data/cctvFootprint.js';

export function createGeometry({ state: layerState, services, parts, source }) {
  const { warmGroundFloor, cachedGroundFloor } = services.ground;
  const { sampleMeshFloorCells } = services.mesh;

  /**
   * Ground measured under the plane's support points for the record's
   * CURRENT pose, or null. Shipped precompute samples (`camera.groundHeights`)
   * were taken for the nominal pose; they apply only while the pose hash still
   * matches, so a calibrated (edited) camera falls back to the mount ground
   * until its own footprint is resolved. Photoreal regime only: the values
   * are aligned to the Google 3D Tiles surface and would be wrong against a
   * globe DEM.
   * @param {Object} record
   * @returns {Record<string, number>|null}
   */
  function footprintGroundFor(record) {
    if (hasShippedFootprint(record)) {
      return record.camera.groundHeights.supports || null;
    }
    // DEM footprint resolved on demand (activation / calibration commit) —
    // valid in either regime, the DEM is what the globe stacks render anyway.
    const resolved = record?.footprintGround;
    if (resolved && resolved.poseHash === poseHash(footprintPose(record))) {
      return resolved.supports || null;
    }
    return null;
  }

  /**
   * The pose the monitor plane is actually rendered with: the calibrated
   * camera fields plus the activation probe's range clamp. Footprint samples
   * (shipped or DEM) are only valid for exactly this pose.
   * @param {Object} record
   * @returns {{lat:number, lon:number, headingDeg:number, pitchDeg:number,
   *   fovDeg:number, rangeM:number, mountHeightM:number}}
   */
  function footprintPose(record) {
    const camera = record.camera;
    const override = parts.model.safeNumber(record.probeClampRangeM, NaN);
    const rangeM =
      Number.isFinite(override) && override > 0
        ? Math.min(camera.rangeM, override)
        : camera.rangeM;
    return {
      lat: camera.lat,
      lon: camera.lon,
      headingDeg: camera.headingDeg,
      pitchDeg: camera.pitchDeg,
      fovDeg: camera.fovDeg,
      rangeM,
      mountHeightM: camera.mountHeightM,
    };
  }

  /**
   * True when the record carries shipped precompute samples for its CURRENT
   * pose and the scene is rendering the Google 3D Tiles surface they are
   * aligned to.
   * @param {Object} record
   * @returns {boolean}
   */
  function hasShippedFootprint(record) {
    const shipped = record?.camera?.groundHeights;
    if (!shipped || typeof shipped !== 'object') return false;
    if (parts.ground.currentSurfaceRegime() !== 'google-3d') return false;
    // Samples describe the pose as served. Any calibration, client clamp or
    // activation range clamp changes the rendered pose and its hash, and the
    // camera then falls back to its own DEM footprint.
    return (
      Number.isFinite(shipped.mountGroundM) &&
      shipped.poseHash === poseHash(footprintPose(record))
    );
  }

  /**
   * V2 core geometry (design §2a): computes the pitched frustum pyramid — mount
   * point, far-cap (monitor plane) center, and the 4 far-plane corners — purely
   * from the calibrated pose + a caller-supplied ground altitude. ZERO scene
   * queries: ground sampling happens in the caller (one-shot snap), and the
   * obstruction probe passes its clamp in as `rangeOverrideM`.
   *
   * Math (spherical small-angle offsets; sub-centimetre at ≤2.2 km ranges):
   *   mountAlt  = groundAltM + mountHeightM
   *   capCenter = projectPoint(heading, R·cos(pitch)) @ alt mountAlt + R·sin(pitch)
   *   halfW     = R·tan(hFov/2)
   *   vFov      = 2·atan(tan(hFov/2) / (16/9))   → halfH = R·tan(vFov/2)
   *   upOffset  = cos(pitch)·halfH vertical + (−sin(pitch))·halfH along heading
   *   corners   = (capCenter ∓ halfW toward heading∓90°) ± upOffset
   * The whole rectangle is then lifted rigidly by the smallest amount that
   * puts every support point (a 3×3 grid over the plane) at least 2 m above
   * the ground measured under it — the ground at the mount where nothing
   * finer is known — so the plane never clips into the terrain and the
   * wireframe rays still terminate exactly on its corners.
   *
   * @param {Object} camera - Pose: lat, lon, headingDeg, pitchDeg, fovDeg,
   *   rangeM, mountHeightM.
   * @param {number} groundAltM - Ground altitude at the mount (metres).
   * @param {number|null} [rangeOverrideM=null] - Obstruction-probe clamp: caps the
   *   effective range (never lengthens it).
   * @param {Record<string, number>|null} [groundUnderPlane=null] - Ground
   *   altitude measured under each plane support point (`bl`…`tr`, see
   *   footprint.js), from the shipped precompute or a DEM lookup.
   * @returns {{ rangeM: number, vFovDeg: number, halfW: number, halfH: number,
   *   mount: {lat:number,lon:number,alt:number},
   *   capCenter: {lat:number,lon:number,alt:number},
   *   corners: { tl: Object, tr: Object, br: Object, bl: Object },
   *   topCenter: {lat:number,lon:number,alt:number}, groundAltM: number }}
   */

  function computeFrustumGeometry(
    camera,
    groundAltM,
    rangeOverrideM = null,
    groundUnderPlane = null,
  ) {
    const ground = parts.model.safeNumber(groundAltM, 0);
    const poseRange = Math.max(1, parts.model.safeNumber(camera.rangeM, 700));
    const override = parts.model.safeNumber(rangeOverrideM, NaN);
    const R =
      Number.isFinite(override) && override > 0
        ? Math.min(poseRange, override)
        : poseRange;
    const pitchDeg = parts.model.clamp(
      parts.model.safeNumber(camera.pitchDeg, -17),
      -89,
      89,
    );
    const fovDeg = parts.model.clamp(
      parts.model.safeNumber(camera.fovDeg, 74),
      8,
      160,
    );
    const heading = parts.model.safeNumber(camera.headingDeg, 0);
    const mountAlt = ground + parts.model.safeNumber(camera.mountHeightM, 24);
    const dims = planeDimensions({ rangeM: R, pitchDeg, fovDeg });

    const capLL = parts.model.projectPoint(
      camera.lat,
      camera.lon,
      heading,
      dims.horiz,
    );
    const capAlt = mountAlt + dims.vert;
    const capL = parts.model.projectPoint(
      capLL.lat,
      capLL.lon,
      heading - 90,
      dims.halfW,
    );
    const capR = parts.model.projectPoint(
      capLL.lat,
      capLL.lon,
      heading + 90,
      dims.halfW,
    );
    // Ground clearance: ONE rigid lift for the whole rectangle, sized by the
    // support point with the largest deficit against the ground measured
    // under it (a 3×3 grid over the plane; see footprint.js). Points without
    // a measurement fall back to the ground at the mount, so with no
    // footprint data the bottom edge still clears the mount's ground — the
    // old center-only clamp left the bottom edge tens of metres underground
    // (owner field test 2026-09-13). The rectangle stays rigid and the
    // wireframe rays still terminate exactly on its corners.
    // Two lifts: what the mount's own ground demands (always honoured), plus
    // whatever the measured footprint adds, capped so a building under the
    // far edge cannot send the plane into the sky.
    const base = requiredPlaneLift(
      capAlt,
      dims,
      null,
      ground,
      FRUSTUM_GROUND_CLEARANCE_M,
    );
    const measured = requiredPlaneLift(
      capAlt,
      dims,
      groundUnderPlane,
      ground,
      FRUSTUM_GROUND_CLEARANCE_M,
    );
    const footprintExtraM = Math.max(0, measured.liftM - base.liftM);
    const liftM =
      base.liftM + Math.min(PLANE_FOOTPRINT_LIFT_CAP_M, footprintExtraM);
    const limitingKey =
      footprintExtraM > 0 ? measured.limitingKey : base.limitingKey;
    const capAltLifted = capAlt + liftM;
    const corner = (base, sign) => {
      const ll = parts.model.projectPoint(
        base.lat,
        base.lon,
        heading,
        sign * dims.upHoriz,
      );
      return {
        lat: ll.lat,
        lon: ll.lon,
        alt: capAltLifted + sign * dims.upVert,
      };
    };

    const topCenter = corner(capLL, 1);
    return {
      rangeM: R,
      vFovDeg: dims.vFovDeg,
      halfW: dims.halfW,
      halfH: dims.halfH,
      mount: { lat: camera.lat, lon: camera.lon, alt: mountAlt },
      capCenter: { lat: capLL.lat, lon: capLL.lon, alt: capAltLifted },
      corners: {
        tl: corner(capL, 1),
        tr: corner(capR, 1),
        br: corner(capR, -1),
        bl: corner(capL, -1),
      },
      topCenter,
      groundAltM: ground,
      liftM,
      liftLimitedBy: limitingKey,
      liftCapped: footprintExtraM > PLANE_FOOTPRINT_LIFT_CAP_M,
      footprintMeasured: !!groundUnderPlane,
    };
  }

  /**
   * Resolves the obstruction probe's effective-range clamp just short of a hit,
   * with the field-derived 12 m floor used by the original H6 monitor.
   * @param {number} rangeM Nominal camera range.
   * @param {number} hitDistanceM Distance to the first obstruction.
   * @returns {number|null} Clamp range, or null when the hit does not shorten it.
   */

  function activationProbeClampRange(rangeM, hitDistanceM) {
    const nominalRange = Number(rangeM);
    const hitDistance = Number(hitDistanceM);
    if (!Number.isFinite(nominalRange) || nominalRange <= 0) return null;
    if (
      !Number.isFinite(hitDistance) ||
      hitDistance <= 0 ||
      hitDistance >= nominalRange
    )
      return null;
    return Math.max(PROBE_MIN_RANGE_M, hitDistance - PROBE_CLEARANCE_M);
  }

  /**
   * Distance along a pitched-down view axis to flat ground at the mount's own
   * ground height, or null for an axis at or above the horizon.
   * @param {number} mountHeightM Mount height above its ground.
   * @param {number} pitchDeg Axis pitch (negative looks down).
   * @returns {number|null}
   */

  function flatGroundAxisDistance(mountHeightM, pitchDeg) {
    const height = Number(mountHeightM);
    const pitch = Number(pitchDeg);
    if (!Number.isFinite(height) || height <= 0 || !(pitch < 0)) return null;
    return height / Math.sin((Math.min(89, -pitch) * Math.PI) / 180);
  }

  /**
   * Unit ECEF direction of the frustum view axis (heading/pitch) at a position.
   * Used by the plane orientation and the activation obstruction probe — both
   * need the UNCLAMPED axis, so it comes from the pose, not from clamped points.
   * @param {Object} camera - Camera pose (headingDeg, pitchDeg).
   * @param {{x: number, y: number, z: number}} atPos - ECEF position defining the local ENU frame.
   * @returns {{ dir: {x: number, y: number, z: number}, up: {x: number, y: number, z: number} }} View axis + the
   *   frame's in-plane "up" (both unit, mutually perpendicular).
   */

  function frustumFrameEcef(camera, atPos) {
    const h = parts.model.toRad(camera.headingDeg);
    const p = parts.model.toRad(camera.pitchDeg);
    const enu = eastNorthUp(atPos);
    // ENU components: view axis + the perpendicular "up" of the pitched cap.
    const dirEnu = vec(
      Math.sin(h) * Math.cos(p),
      Math.cos(h) * Math.cos(p),
      Math.sin(p),
    );
    const upEnu = vec(
      -Math.sin(p) * Math.sin(h),
      -Math.sin(p) * Math.cos(h),
      Math.cos(p),
    );
    return {
      dir: frameVector(enu, dirEnu),
      up: frameVector(enu, upEnu),
    };
  }

  /**
   * Recomputes the pure frustum geometry from the camera pose + the given ground
   * altitude and writes it into the scene: icon position, the 5 wireframe
   * polylines (4 corner rays + closed far-plane rectangle), and the monitor
   * plane placement. This is the ONLY place v2 geometry is written — called on
   * slider input / save / activation / the one-shot ground snap, never per frame.
   * @param {Object} record - Camera record.
   * @param {number} groundAltM - Ground altitude at the mount (metres).
   */

  function applyFrustumGeometry(record, groundAltM) {
    const geometry = computeFrustumGeometry(
      record.camera,
      groundAltM,
      record.probeClampRangeM,
      footprintGroundFor(record),
    );
    const positions = parts.rendering.frustumCartesians(geometry);
    record.frustumGeometry = geometry;
    record.frustumPositions = positions;
    record.position = positions.mount;
    record.camera.absoluteHeightM = geometry.mount.alt;
    parts.rendering.moveCameraIcon(record);
    record.groundAltM = groundAltM;
    if (record.coverageEntities?.length >= 5) {
      parts.rendering.placeCoverageLines(record.coverageEntities, positions);
      parts.drawSets.writeLines(record.coverageEntities);
    }
    // A live viewshed volume tracks its wireframe: rebuild from the SAME fresh
    // positions (weld invariant). Only records currently showing a volume pay
    // this (6 triangles, synchronous — trivial even during slider/gizmo drags).
    // Tint derives from the live active id, not the cached viewshedActiveTint —
    // during an activation switch this runs BEFORE refreshCoverageStyles, and
    // the cache is stale for exactly that window.
    if (record.viewshedVolume) {
      parts.rendering.rebuildViewshedVolume(
        record,
        record.camera.id === layerState._activeCameraId,
      );
    }
    parts.projection.updatePlanePlacement(record);
    // Gizmo handles track the pose they manipulate: refresh when the ACTIVE
    // camera's geometry rewrites (incl. during its own drag).
    if (
      layerState._gizmo?.isEnabled() &&
      record.camera.id === layerState._activeCameraId
    ) {
      layerState._gizmo.refresh();
    }
  }

  /**
   * Refreshes a record's frustum geometry with a regime-aware, ONE-SHOT ground
   * resolution (Task 5, spec §2). Per regime:
   *
   *  - `terrain-globe` (any globe stack): `cachedGroundFloor` returns its DEM
   *    floor because mesh floors are regime-disabled. The exact Re:Earth prior
   *    remains the immediate fallback while that coarse cell warms.
   *  - `google-3d` (photoreal): the shared mesh-floor sampler may refine the
   *    DEM cell once, subject to its existing tiles-ready, distance,
   *    camera-height, and acceptance gates. Geometry reads only
   *    `cachedGroundFloor`, never a CCTV-owned point sample.
   *
   * v2 samples ONLY the mount — the far cap hangs in the air off mountAlt. No
   * timer, no deadband: this function is called only from the staggered
   * geometry queue (the enable-time drain + update()'s one-shot tiles-ready
   * completion re-enqueue), from explicit pose-edit call sites, and from the
   * map-stack regime-change handler.
   * @param {Object} record - Camera record.
   * @param {Object} [options={}]
   * @param {boolean} [options.sampleGround=true] - When false, skip shared
   *   mesh-floor refinement and use the cached/prior ground instead.
   */

  function updateRecordGeometry(record, options = {}) {
    const sampleGround = options.sampleGround !== false;
    const regime = parts.ground.currentSurfaceRegime();
    const point = { lat: record.camera.lat, lon: record.camera.lon };
    warmGroundFloor([point]);

    if (regime === 'terrain-globe') {
      const cachedFloor = cachedGroundFloor(point.lat, point.lon);
      const ground = Number.isFinite(cachedFloor)
        ? cachedFloor
        : parts.ground.groundPriorAltFor(record);
      record.groundSamples['terrain-globe'] = ground;
      record.groundResolved['terrain-globe'] = true;
      applyFrustumGeometry(record, ground);
      return;
    }

    // Photoreal regime with shipped precompute samples for exactly this pose:
    // the mount ground and the footprint come from the sidecar, no scene
    // query and no shared-cell write (aircraft floors stay untouched).
    if (hasShippedFootprint(record)) {
      const shippedGround = record.camera.groundHeights.mountGroundM;
      record.groundSamples['google-3d'] = shippedGround;
      record.groundResolved['google-3d'] = true;
      applyFrustumGeometry(record, shippedGround);
      return;
    }

    // Photoreal regime. Sampling is delegated to the shared coarse-cell
    // sampler. It remains event-driven, a few probes per cell, and keeps its
    // existing acceptance window; CCTV adds no rooftop rejection policy.
    if (sampleGround && parts.model.projectionTilesReady()) {
      record.groundMeshSampleRequestCount =
        (record.groundMeshSampleRequestCount || 0) + 1;
      const eye = parts.model.eyePose();
      // The layer's own lines and plane are not ground; named all the same.
      sampleMeshFloorCells(layerState._viewer, [point], {
        sets: parts.drawSets.pickableSetIds(),
        viewerLat: eye ? eye.lat : undefined,
        viewerLon: eye ? eye.lon : undefined,
      });
    }

    const cachedFloor = cachedGroundFloor(point.lat, point.lon);
    const ground = Number.isFinite(cachedFloor)
      ? cachedFloor
      : parts.ground.groundAltFor(record, 'google-3d');
    applyFrustumGeometry(record, ground);

    record.groundResolved['google-3d'] = Number.isFinite(cachedFloor);
    if (Number.isFinite(cachedFloor)) {
      record.groundSamples['google-3d'] = ground;
    }
  }

  /**
   * Determines which camera coverage overlays should be visible based on
   * proximity to the active camera. Limits visibility to
   * COVERAGE_NEIGHBOR_LIMIT cameras within COVERAGE_NEIGHBOR_RADIUS_KM.
   * @param {Object|null} activeRecord - The active camera record.
   * @returns {Set<string>} Set of visible camera IDs.
   */

  function buildCoverageVisibleSet(activeRecord) {
    if (!layerState._records.length) return new Set();
    // Coverage emphasis is relative to a selected camera. Without one, do not
    // invent an arbitrary catalog-order cohort.
    if (!activeRecord) return new Set();

    const ranked = layerState._records.map((record) => {
      if (record === activeRecord) {
        return { record, distKm: -1 };
      }
      return {
        record,
        distKm: parts.model.haversineKm(
          activeRecord.camera.lat,
          activeRecord.camera.lon,
          record.camera.lat,
          record.camera.lon,
        ),
      };
    });

    ranked.sort((a, b) => a.distKm - b.distKm);

    const primary = ranked.filter(
      (entry) =>
        entry.distKm <= COVERAGE_NEIGHBOR_RADIUS_KM || entry.distKm === -1,
    );
    const fallback = ranked;
    const chosen = (
      primary.length >= COVERAGE_NEIGHBOR_LIMIT ? primary : fallback
    )
      .slice(0, COVERAGE_NEIGHBOR_LIMIT)
      .map((entry) => entry.record.camera.id);
    return new Set(chosen);
  }

  /**
   * Counts how many other cameras have overlapping coverage with the target.
   * Overlap is approximated by comparing inter-camera distance against the
   * combined range of both cameras (scaled by 0.92).
   * @param {Object} targetRecord - Camera record to check.
   * @returns {number} Number of overlapping neighbors.
   */

  function coverageNeighborCount(targetRecord) {
    if (!targetRecord) return 0;
    // The summary asks on every notification; scan the catalog only when the
    // camera, its pose or the catalog changed.
    const { id, lat, lon, rangeM } = targetRecord.camera;
    const key = `${id}|${lat}|${lon}|${rangeM}|${layerState._records.length}`;
    const cached = layerState._neighborCountCache;
    if (cached?.key === key && cached.records === layerState._records)
      return cached.count;
    let count = 0;
    for (const record of layerState._records) {
      if (record === targetRecord) continue;
      const dKm = parts.model.haversineKm(
        targetRecord.camera.lat,
        targetRecord.camera.lon,
        record.camera.lat,
        record.camera.lon,
      );
      const overlapKm =
        ((targetRecord.camera.rangeM + record.camera.rangeM) / 1000) * 0.92;
      if (dKm <= overlapKm) count++;
    }
    layerState._neighborCountCache = {
      key,
      records: layerState._records,
      count,
    };
    return count;
  }

  /**
   * §9.1 activation obstruction probe (LOCKED owner decision): on camera
   * ACTIVATION only, cast ONE ray against the scene along the frustum axis
   * (mount → cap-center direction). If it hits the tiles closer than the pose
   * range, clamp the plane's effective range just short of the first hit so the
   * "big and dramatic" true end cap never clips into downtown buildings.
   *
   * On a globe map it also casts along the same axis against the globe's
   * terrain (flat ground at the mount's ground when terrain is missed or met
   * beyond the range) and clamps at the nearer end. These are the ONLY
   * raycasts in the whole CCTV subsystem — once per activation, never
   * per-frame (the zero-raycast invariant applies to steady state). The
   * per-camera range slider overrides the clamp: a user-set rangeScale skips
   * the probe entirely. A miss on the photoreal stack or a probe failure
   * keeps the unclamped range.
   *
   * The casts are made now, against the scene as it is, and answer a
   * microtask later: the clamp then lands by rewriting the geometry from the
   * ground it was last written at, before the next frame draws. A newer
   * activation, or the camera's deactivation, drops an answer still to come.
   * @param {Object} record - Camera record being activated.
   * @returns {Promise<void>} Settled once the clamp (if any) has landed.
   */

  function runActivationObstructionProbe(record) {
    record.probeClampRangeM = null;
    const token = (record.probeToken = (record.probeToken || 0) + 1);
    const viewer = layerState._viewer;
    if (!parts.rendering.canPickFromRay()) return Promise.resolve();
    const camera = record.camera;
    const rangeScale = parts.calibration.normalizeCalibration(
      camera.calibration,
    ).rangeScale;
    // The slider overrides the clamp.
    if (Math.abs(rangeScale - 1) > 0.0001) return Promise.resolve();
    try {
      const mountAlt = parts.ground.groundAltFor(record) + camera.mountHeightM;
      const mountPos = fromDegrees(camera.lon, camera.lat, mountAlt);
      const { dir } = frustumFrameEcef(camera, mountPos);
      // The casts see through everything the layer draws. The surface cast
      // meets what is drawn on the globe (the photoreal tiles); on a globe
      // map the axis also ends on the globe's terrain, the nearer of that and
      // any surface hit. A hit at or beyond the range counts as none. Terrain
      // still loading at a coarse level can be missed or met beyond the
      // range; then flat ground at the mount's own ground stands in for it.
      const inRange = (d) => Number.isFinite(d) && d > 0 && d < camera.rangeM;
      return Promise.all([
        parts.rendering.obstructionHit(mountPos, dir),
        parts.rendering.terrainHit?.(mountPos, dir) ?? null,
      ])
        .then(([hit, terrain]) => {
          if (record.probeToken !== token) return;
          if (record.camera.id !== layerState._activeCameraId) return;
          // A layer torn down or re-initialised since (another viewer, or
          // a new record for the same camera) is not the one it asked for.
          if (layerState._viewer !== viewer) return;
          if (layerState._recordById?.get(record.camera.id) !== record) return;
          const hitDist = hit ? distance(mountPos, hit) : NaN;
          const distances = inRange(hitDist) ? [hitDist] : [];
          if (terrain) {
            const terrainDist = terrain.hit
              ? distance(mountPos, terrain.hit)
              : NaN;
            const ground = inRange(terrainDist)
              ? terrainDist
              : flatGroundAxisDistance(camera.mountHeightM, camera.pitchDeg);
            if (Number.isFinite(ground) && ground > 0) distances.push(ground);
          }
          if (!distances.length) return;
          const clamp = activationProbeClampRange(
            camera.rangeM,
            Math.min(...distances),
          );
          if (!Number.isFinite(clamp)) return;
          record.probeClampRangeM = clamp;
          if (Number.isFinite(record.groundAltM))
            applyFrustumGeometry(record, record.groundAltM);
          // The activation asked for the ground under the unclamped plane's
          // footprint; the clamped plane's is asked for now, and the layer
          // restyles and tells its listeners, as that answer will.
          void parts.ground.resolveFootprintGround(record);
          parts.rendering.refreshCoverageStyles();
          parts.presentation.notifyListeners();
        })
        .catch(() => {
          // probe failure → keep the unclamped range
        });
    } catch {
      // probe failure → keep the unclamped range
      return Promise.resolve();
    }
  }

  /**
   * Clears a deactivated camera's temporary obstruction clamp and rewrites its
   * geometry through the normal single-range path.
   * @param {Object|null} record Camera runtime record being deactivated.
   * @param {(record: Object) => void} rewriteGeometry Nominal geometry rewrite.
   * @returns {boolean} Whether a clamp was cleared.
   */

  function clearProbeClampOnDeactivation(record, rewriteGeometry) {
    if (record) record.probeToken = (record.probeToken || 0) + 1;
    if (!record || !Number.isFinite(record.probeClampRangeM)) return false;
    record.probeClampRangeM = null;
    rewriteGeometry?.(record);
    return true;
  }

  /**
   * Materializes coverage entities for eligible records exactly once.
   * The helper is dependency-injected so unit tests can prove the enable policy
   * without constructing entities.
   *
   * @param {Object[]} records CCTV runtime records.
   * @param {(record: Object) => boolean} [isEligible] Eligibility predicate.
   * @param {(record: Object) => Object[]} buildEntities Coverage builder.
   * @returns {Object[]} Newly created entities across all eligible records.
   */

  function materializeCctvCoverageEntities(
    records,
    isEligible = () => true,
    buildEntities,
  ) {
    const created = [];
    if (typeof buildEntities !== 'function') return created;
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || record.coverageEntities?.length || !isEligible(record))
        continue;
      const entities = buildEntities(record);
      record.coverageEntities = Array.isArray(entities)
        ? entities.filter(Boolean)
        : [];
      created.push(...record.coverageEntities);
    }
    return created;
  }

  /** Materializes one active camera's coverage set. */

  function materializeCctvActiveCoverageEntities(record, buildEntities) {
    return materializeCctvCoverageEntities([record], () => true, buildEntities);
  }

  /** Materializes only records in the current coverage-visible ID set. */

  function materializeCctvVisibleCoverageEntities(
    records,
    visibleIds,
    buildEntities,
  ) {
    const eligibleIds =
      visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
    return materializeCctvCoverageEntities(
      records,
      (record) => eligibleIds.has(record.camera?.id),
      buildEntities,
    );
  }

  /** Registers newly built coverage entities with the layer-global collection. */

  function registerCoverageEntities(created) {
    layerState._coverageEntities.push(...created);
    return created;
  }

  function ensureActiveCoverageEntities(record) {
    return registerCoverageEntities(
      materializeCctvActiveCoverageEntities(
        record,
        parts.rendering.buildCoverageEntities,
      ),
    );
  }

  function ensureVisibleCoverageEntities(records, visibleIds) {
    return registerCoverageEntities(
      materializeCctvVisibleCoverageEntities(
        records,
        visibleIds,
        parts.rendering.buildCoverageEntities,
      ),
    );
  }

  /**
   * Removes all coverage entities and projection runtimes from the scene.
   */

  function destroyCoverageEntities() {
    if (!layerState._viewer) return;
    parts.rendering.removeCoverageEntities();
    layerState._coverageEntities = [];

    for (const record of layerState._records) {
      parts.rendering.destroyViewshedVolume(record);
    }

    for (const runtime of layerState._projectionEntities) {
      parts.projection.destroyProjectionRuntime(runtime);
    }
    layerState._projectionEntities = [];
  }
  return {
    computeFrustumGeometry,
    hasShippedFootprint,
    footprintPose,
    activationProbeClampRange,
    flatGroundAxisDistance,
    frustumFrameEcef,
    applyFrustumGeometry,
    updateRecordGeometry,
    buildCoverageVisibleSet,
    coverageNeighborCount,
    runActivationObstructionProbe,
    clearProbeClampOnDeactivation,
    materializeCctvCoverageEntities,
    materializeCctvActiveCoverageEntities,
    materializeCctvVisibleCoverageEntities,
    registerCoverageEntities,
    ensureActiveCoverageEntities,
    ensureVisibleCoverageEntities,
    destroyCoverageEntities,
  };
}
