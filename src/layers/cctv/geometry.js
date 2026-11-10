import * as geo from '../../geo/index.js';
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
   * Converts a computeFrustumGeometry result into the Cartesian3 positions the
   * entities consume. Fresh objects per call (geometry updates are rare —
   * slider/save/activation — and entities must never share scratch objects).
   * @param {Object} geometry - Result of computeFrustumGeometry.
   * @returns {{ mount: Cesium.Cartesian3, capCenter: Cesium.Cartesian3,
   *   tl: Cesium.Cartesian3, tr: Cesium.Cartesian3, br: Cesium.Cartesian3,
   *   bl: Cesium.Cartesian3, label: Cesium.Cartesian3 }}
   */

  function frustumCartesians(geometry) {
    const at = (p) => geo.cartesian3.fromDegrees(p.lon, p.lat, p.alt);
    return {
      mount: at(geometry.mount),
      capCenter: at(geometry.capCenter),
      tl: at(geometry.corners.tl),
      tr: at(geometry.corners.tr),
      br: at(geometry.corners.br),
      bl: at(geometry.corners.bl),
      label: geo.cartesian3.fromDegrees(
        geometry.topCenter.lon,
        geometry.topCenter.lat,
        geometry.topCenter.alt + 1.2,
      ),
    };
  }

  /**
   * Unit ECEF direction of the frustum view axis (heading/pitch) at a position.
   * Used by the plane orientation and the activation obstruction probe — both
   * need the UNCLAMPED axis, so it comes from the pose, not from clamped points.
   * @param {Object} camera - Camera pose (headingDeg, pitchDeg).
   * @param {Cesium.Cartesian3} atPos - ECEF position defining the local ENU frame.
   * @returns {{ dir: Cesium.Cartesian3, up: Cesium.Cartesian3 }} View axis + the
   *   frame's in-plane "up" (both unit, mutually perpendicular).
   */

  function frustumFrameEcef(camera, atPos) {
    const h = parts.model.toRad(camera.headingDeg);
    const p = parts.model.toRad(camera.pitchDeg);
    const enu = geo.transforms.eastNorthUpToFixedFrame(atPos);
    const rot = geo.matrix4.getMatrix3(enu, geo.matrix3.create());
    // ENU components: view axis + the perpendicular "up" of the pitched cap.
    const dirEnu = geo.cartesian3.create(
      Math.sin(h) * Math.cos(p),
      Math.cos(h) * Math.cos(p),
      Math.sin(p),
    );
    const upEnu = geo.cartesian3.create(
      -Math.sin(p) * Math.sin(h),
      -Math.sin(p) * Math.cos(h),
      Math.cos(p),
    );
    return {
      dir: geo.matrix3.multiplyByVector(rot, dirEnu, geo.cartesian3.create()),
      up: geo.matrix3.multiplyByVector(rot, upEnu, geo.cartesian3.create()),
    };
  }

  /**
   * Recomputes the pure frustum geometry from the camera pose + the given ground
   * altitude and writes it into the scene: billboard position, the 5 wireframe
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
    const positions = frustumCartesians(geometry);
    record.frustumGeometry = geometry;
    record.frustumPositions = positions;
    record.position = positions.mount;
    record.camera.absoluteHeightM = geometry.mount.alt;
    if (record.billboard) {
      record.billboard.position = positions.mount;
    }
    parts.renderer?.updateCoverage(record, positions);
    // A live viewshed volume tracks its wireframe: rebuild from the SAME fresh
    // positions (weld invariant). Only records currently showing a volume pay
    // this (6 triangles, synchronous — trivial even during slider/gizmo drags).
    // Tint derives from the live active id, not the cached viewshedActiveTint —
    // during an activation switch this runs BEFORE refreshCoverageStyles, and
    // the cache is stale for exactly that window.
    if (record.viewshedPrimitive) {
      rebuildViewshedVolume(
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
      const viewerCarto = parts.renderer?.cameraCartographic();
      const excludeObjects = [...(record.coverageEntities || [])];
      if (record.billboard) excludeObjects.push(record.billboard);
      if (record.projection?.planeEntity)
        excludeObjects.push(record.projection.planeEntity);
      parts.renderer.sampleMeshFloorCells([point], {
        excludeObjects: excludeObjects.filter(Boolean),
        viewerLat: viewerCarto
          ? geo.math.toDegrees(viewerCarto.latitude)
          : undefined,
        viewerLon: viewerCarto
          ? geo.math.toDegrees(viewerCarto.longitude)
          : undefined,
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
   * Removes (and destroys) a record's viewshed volume primitive, if any.
   * @param {Object} record - Camera record.
   */

  function destroyViewshedVolume(record) {
    if (!record) return;
    if (record.viewshedPrimitive)
      parts.renderer?.removeVolume(record.viewshedPrimitive);
    record.viewshedPrimitive = null;
  }

  /**
   * (Re)builds a record's translucent viewshed volume from its CURRENT
   * frustumPositions — the same 5 Cartesians the wireframe draws, so the volume
   * is welded to the cone by construction. Called only where the wireframe
   * already rewrites (style refresh on mode/visible-set/active changes,
   * applyFrustumGeometry on pose edits) — no new update cadence, zero scene
   * queries (viewshed design §3b).
   * @param {Object} record - Camera record.
   * @param {boolean} isActive - Active camera gets the brighter fill.
   */

  function rebuildViewshedVolume(record, isActive) {
    destroyViewshedVolume(record);
    if (
      !parts.renderer?.ready ||
      !record?.frustumPositions ||
      !record.viewshedColors
    )
      return;
    const color = isActive
      ? record.viewshedColors.fillActive
      : record.viewshedColors.fill;
    record.viewshedPrimitive = parts.renderer.createVolume(record, color);
    record.viewshedActiveTint = !!isActive;
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
   * ACTIVATION only, fire ONE scene.pickFromRay along the frustum axis
   * (mount → cap-center direction). If it hits the tiles closer than the pose
   * range, clamp the plane's effective range just short of the first hit so the
   * "big and dramatic" true end cap never clips into downtown buildings.
   *
   * This is the ONLY raycast in the whole CCTV subsystem — once per activation,
   * never per-frame (the zero-raycast invariant applies to steady state). The
   * per-camera range slider overrides the clamp: a user-set rangeScale skips the
   * probe entirely. Probe failure/miss keeps the unclamped range.
   * @param {Object} record - Camera record being activated.
   */

  function runActivationObstructionProbe(record) {
    record.probeClampRangeM = null;
    if (!parts.renderer?.ready) return;
    const camera = record.camera;
    const rangeScale = parts.calibration.normalizeCalibration(
      camera.calibration,
    ).rangeScale;
    if (Math.abs(rangeScale - 1) > 0.0001) return; // slider overrides the clamp
    try {
      const mountAlt = parts.ground.groundAltFor(record) + camera.mountHeightM;
      const mountPos = geo.cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        mountAlt,
      );
      const { dir } = frustumFrameEcef(camera, mountPos);
      // Exclude everything the layer itself draws so the probe can only hit the
      // world (3D tiles), not our own billboards/polylines/planes.
      const exclude = [...layerState._coverageEntities];
      for (const runtime of layerState._projectionEntities) {
        if (runtime?.planeEntity) exclude.push(runtime.planeEntity);
      }
      for (const other of layerState._records) {
        if (other.viewshedPrimitive) exclude.push(other.viewshedPrimitive);
      }
      const hit = parts.renderer.obstructionRay(
        mountPos,
        dir,
        exclude,
        camera.rangeM,
      );
      if (!hit?.position) return;
      const dist = geo.cartesian3.distance(mountPos, hit.position);
      record.probeClampRangeM = activationProbeClampRange(camera.rangeM, dist);
    } catch {
      // probe failure → keep the unclamped range
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
    if (!record || !Number.isFinite(record.probeClampRangeM)) return false;
    record.probeClampRangeM = null;
    rewriteGeometry?.(record);
    return true;
  }

  /**
   * Creates the five Cesium polyline entities that visualize a camera's pitched
   * frustum: 4 corner rays (mount → far-plane corner) + the closed far-plane
   * rectangle. Entity ids stay in the `cctv-<id>-<role>` scheme (pick-owner
   * regex depends on it): roles ray-tl / ray-tr / ray-br / ray-bl / cap.
   * @param {Object} record - Camera record.
   * @returns {Cesium.Entity[]} Array of five coverage entities.
   */

  function buildCoverageEntities(record) {
    const { camera } = record;
    // Prefer the record's already-refined geometry. Lazy creation commonly
    // happens after the staggered ground pass; recomputing from the catalog
    // prior here would regress the camera to its pre-sampled datum.
    let geometry = record.frustumGeometry;
    let positions = record.frustumPositions;
    if (!geometry || !positions) {
      geometry = computeFrustumGeometry(
        camera,
        parts.ground.groundPriorAltFor(record),
        record.probeClampRangeM,
      );
      positions = frustumCartesians(geometry);
      record.frustumGeometry = geometry;
      record.frustumPositions = positions;
      record.position = positions.mount;
    }

    return parts.renderer.createCoverage(camera.id, positions);
  }

  /**
   * Materializes coverage entities for eligible records exactly once.
   * The helper is dependency-injected so unit tests can prove the enable policy
   * without constructing Cesium entities.
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
      materializeCctvActiveCoverageEntities(record, buildCoverageEntities),
    );
  }

  function ensureVisibleCoverageEntities(records, visibleIds) {
    return registerCoverageEntities(
      materializeCctvVisibleCoverageEntities(
        records,
        visibleIds,
        buildCoverageEntities,
      ),
    );
  }

  /**
   * Removes all coverage entities and projection runtimes from the scene.
   */

  function destroyCoverageEntities({ retainMedia = false } = {}) {
    for (const entity of layerState._coverageEntities) {
      parts.renderer?.removeCoverageEntity(entity);
    }
    layerState._coverageEntities = [];

    for (const record of layerState._records) {
      destroyViewshedVolume(record);
    }

    for (const runtime of layerState._projectionEntities) {
      if (retainMedia) {
        if (runtime.planeEntity) parts.renderer.removePlane(runtime);
        runtime.planeEntity = runtime.planeMaterial = null;
        runtime.planeVisible = false;
        runtime.needsPlane = true;
      } else parts.projection.destroyProjectionRuntime(runtime);
    }
    if (!retainMedia) layerState._projectionEntities = [];
  }
  return {
    computeFrustumGeometry,
    hasShippedFootprint,
    footprintPose,
    activationProbeClampRange,
    frustumCartesians,
    frustumFrameEcef,
    applyFrustumGeometry,
    updateRecordGeometry,
    buildCoverageVisibleSet,
    destroyViewshedVolume,
    rebuildViewshedVolume,
    coverageNeighborCount,
    runActivationObstructionProbe,
    clearProbeClampOnDeactivation,
    buildCoverageEntities,
    materializeCctvCoverageEntities,
    materializeCctvActiveCoverageEntities,
    materializeCctvVisibleCoverageEntities,
    registerCoverageEntities,
    ensureActiveCoverageEntities,
    ensureVisibleCoverageEntities,
    destroyCoverageEntities,
  };
}
