import { cycleIndex } from '../../data/layerSteps.js';
import { distance } from '../../geo/vector.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { rangeForBoundingSphere } from '../../data/cameraFraming.js';
import { isFollowing } from '../../data/followed.js';
import {
  cellBounds,
  cellCenter,
  cellHalfExtents,
} from '../../data/cctvCellCounts.js';
import { CCTV_FOCUS_RESULT, VIEW_CELL_PX, VIEW_MIN_CELL_M } from './policy.js';
import { cameraOf, canvasOf, findCamera } from '../../render/rendererOf.js';

/** How many of the cameras nearest the view a walk steps through without Context's list. */
const CAMERA_WALK_SIZE = 25;

export function createNavigation({
  state: layerState,
  services,
  parts,
  source,
}) {
  let previewedCameraId = null;
  function setPreviewedCamera(cameraId) {
    if (previewedCameraId === cameraId) return;
    if (previewedCameraId) layerState._lastHopAt = Date.now();
    previewedCameraId = cameraId;
  }

  /**
   * Nearest catalog camera to a WGS84 point.
   * @param {number} lat Latitude in degrees.
   * @param {number} lon Longitude in degrees.
   * @returns {string|null} Camera ID, or null (invalid point, empty catalog).
   */
  function nearestCameraIdToPoint(lat, lon) {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      !layerState._records.length
    )
      return null;

    let best = null;
    for (const record of layerState._records) {
      const distKm = parts.model.haversineKm(
        lat,
        lon,
        record.camera.lat,
        record.camera.lon,
      );
      if (!best || distKm < best.distKm) {
        best = { id: record.camera.id, distKm };
      }
    }
    return best?.id || null;
  }

  /**
   * Finds the camera closest to the viewer's current position.
   * @returns {string|null} Camera ID of the nearest camera, or null.
   */
  function nearestCameraIdToViewer() {
    const pose = parts.model.eyePose();
    if (!pose) return null;
    return nearestCameraIdToPoint(pose.lat, pose.lon);
  }

  /**
   * The camera the layer opens on when none is selected: the one nearest the
   * viewer, or the first record when the viewer has no position yet.
   * @returns {string|null} Camera ID, or null when the catalog is empty.
   */

  function openingCameraId() {
    return (
      nearestCameraIdToViewer() || layerState._records[0]?.camera?.id || null
    );
  }

  /** Run a layer-owned activation without treating it as someone's pick. */
  function quietly(activate) {
    layerState._quietActivation = true;
    try {
      activate();
    } finally {
      layerState._quietActivation = false;
    }
  }

  /**
   * After a settled move, moves the opening camera to the one nearest the
   * view, until someone chooses a camera. A shared view's flight lands after
   * enable() picked from the startup view.
   * @returns {boolean} True when the active camera changed.
   */
  function reopenNearestCamera() {
    if (!layerState._openingCameraProvisional || !layerState._enabled)
      return false;
    const nearest = nearestCameraIdToViewer();
    if (!nearest || nearest === layerState._activeCameraId) return false;
    // Still the layer's own opening pick, nobody's choice: its notification
    // says so (as a restored camera's does), so Context opens no card for it.
    // Later settled moves may still replace it.
    quietly(() => parts.selection.setActiveCamera(nearest, { opening: true }));
    return true;
  }

  /** What holds the view instead of a CCTV flight, or null when it is free. */
  function viewHeldBy(viewer) {
    if (
      typeof document !== 'undefined' &&
      document.body?.classList.contains('cockpit-mode')
    )
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    return isFollowing(viewer) ? CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW : null;
  }

  /**
   * Camera IDs within a radius of a point, nearest first.
   * @param {{lat: number, lon: number}} at
   * @param {{radiusKm?: number, limit?: number}} [options]
   * @returns {string[]}
   */
  function nearestCameraIds(
    at,
    { radiusKm = Infinity, limit = Infinity } = {},
  ) {
    if (
      !layerState._enabled ||
      !Number.isFinite(at?.lat) ||
      !Number.isFinite(at?.lon)
    )
      return [];
    const found = [];
    for (const record of layerState._records) {
      const camera = record?.camera;
      if (!Number.isFinite(camera?.lat) || !Number.isFinite(camera?.lon))
        continue;
      const km = parts.model.haversineKm(
        at.lat,
        at.lon,
        camera.lat,
        camera.lon,
      );
      if (km <= radiusKm) found.push({ id: camera.id, km });
    }
    return found
      .sort((a, b) => a.km - b.km)
      .slice(0, limit)
      .map(({ id }) => id);
  }

  /**
   * The area Context lists cameras for (its view centre and radius), so a
   * walk steps through the same list; null while Context shows no list.
   * `order` is the list's camera ids as it shows them (searched and sorted),
   * only while the list is on screen. `restart` drops the walk under way, as
   * when the list's search changes, it is shown or hidden, or Context opens
   * or closes (then with no area); a recentre keeps it.
   * @param {?{lat: number, lon: number, radiusKm: number, order?: string[], restart?: boolean}} area
   */
  function setNearbyArea(area) {
    if (area?.restart) layerState._cameraWalk = null;
    layerState._nearbyArea =
      Number.isFinite(area?.lat) &&
      Number.isFinite(area?.lon) &&
      Number.isFinite(area?.radiusKm) &&
      area.radiusKm > 0
        ? {
            lat: area.lat,
            lon: area.lon,
            radiusKm: area.radiusKm,
            order: Array.isArray(area.order) ? area.order.map(String) : null,
          }
        : null;
  }

  /**
   * A new walk follows the visible Context list. With no visible list, use
   * the nearby area if one is available, then the cameras nearest the view.
   * @returns {?Array<string>}
   */
  function walkOrder() {
    const area = layerState._nearbyArea;
    if (area?.order) return area.order;
    if (area) {
      const listed = nearestCameraIds(area, { radiusKm: area.radiusKm });
      if (listed.length > 1) return listed;
    }
    const at = area || walkStart();
    if (!at) return null;
    return nearestCameraIds(at, { limit: CAMERA_WALK_SIZE });
  }

  /** The middle of the view's rectangle, across the date line too; null without one. */
  function viewMiddle() {
    const rect = layerState._viewer
      ? findCamera(layerState._viewer)?.viewRectangle?.()
      : null;
    if (
      ![rect?.west, rect?.south, rect?.east, rect?.north].every(Number.isFinite)
    )
      return null;
    const span = rect.east - rect.west + (rect.west > rect.east ? 360 : 0);
    let lon = rect.west + span / 2;
    if (lon > 180) lon -= 360;
    return { lat: (rect.south + rect.north) / 2, lon };
  }

  /** Where a new walk starts: the middle of the view, else the point under the viewer, else the open camera. */
  function walkStart() {
    const centre = viewMiddle() || parts.model.eyePose();
    if (Number.isFinite(centre?.lat) && Number.isFinite(centre?.lon))
      return centre;
    const active = layerState._recordById.get(layerState._activeCameraId);
    return Number.isFinite(active?.camera?.lat) ? active.camera : null;
  }

  /** Whether the active walk or listed order offers another camera. */
  function canStepNearby() {
    if (!layerState._enabled || layerState._records.length < 2) return false;
    const activeId = layerState._activeCameraId;
    const walk = layerState._cameraWalk;
    const order =
      walk && walk.lastId === activeId
        ? walk.order
        : layerState._nearbyArea?.order;
    return (
      !order ||
      order.some((id) => id !== activeId && layerState._recordById.has(id))
    );
  }

  /**
   * Selects the previous or next camera in the shown Context list or a
   * list of nearby cameras (see walkOrder). Its card opens, and the camera
   * is framed unless focus is false. A walk keeps its order while its last
   * camera stays selected. From outside the walk, either step selects its
   * first camera.
   * @param {number} direction Negative for previous, otherwise next.
   * @param {Object} [options]
   * @param {boolean} [options.focus=true] Fly to the camera after selecting it.
   * @param {number} [options.durationSec=1.8] Fly-to duration in seconds.
   * @returns {?{cameraId: string, focusResult: ?string}} Null when the layer
   *   is off or no other camera is near.
   */
  function stepNearbyCamera(direction, options = {}) {
    if (!layerState._enabled || !layerState._records.length) return null;
    const activeId = layerState._activeCameraId;
    let walk = layerState._cameraWalk;
    if (!walk || walk.lastId !== activeId) {
      const order = walkOrder();
      if (!order) return null;
      walk = { order, lastId: activeId };
      layerState._cameraWalk = walk;
    }
    const { order } = walk;
    const index = order.indexOf(activeId);
    const nextId =
      order[cycleIndex(index, direction < 0 ? -1 : 1, order.length, 0)];
    if (!nextId || nextId === activeId) return null;
    if (!layerState._recordById.has(nextId)) {
      // The catalog changed under the walk: the next step starts afresh.
      layerState._cameraWalk = null;
      return null;
    }
    parts.selection.setActiveCamera(nextId);
    walk.lastId = nextId;
    const focusResult =
      options.focus === false
        ? null
        : focusCamera(nextId, options.durationSec || 1.8);
    return { cameraId: nextId, focusResult };
  }

  /**
   * Flies the viewer's camera to frame the specified CCTV camera,
   * looking along its heading from above.
   * @param {object|null} viewer The viewer that owns the camera.
   * @param {Object|null} record CCTV camera runtime record.
   * @param {number} [duration=2.2] - Flight duration in seconds.
   * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
   */

  function focusCctvRecord(viewer, record, duration = 2.2) {
    if (!viewer || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    const held = viewHeldBy(viewer);
    if (held === CCTV_FOCUS_RESULT.COCKPIT_ACTIVE) {
      console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    }
    if (held === CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW) {
      console.debug(
        '[Data:CCTV] focus ignored while a tracked entity owns the camera',
      );
      return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
    }
    const { camera } = record;
    const range = Math.max(280, camera.rangeM * 1.18);
    cameraOf(viewer).flyToBounds(
      { center: record.position, radius: Math.max(40, camera.rangeM * 0.36) },
      {
        offset: {
          heading: parts.model.toRad(camera.headingDeg),
          pitch: parts.model.toRad(-22),
          range,
        },
        durationS: Math.max(0.2, duration || 0),
        easing: 'cubicInOut',
      },
    );
    return CCTV_FOCUS_RESULT.FOCUSED;
  }

  /** The nearest ground cell with two or more cameras, or the group itself if unmerged. */
  function nearestPart(cell, eye) {
    let nearest = cell;
    let best = Infinity;
    for (const part of cell.parts ?? []) {
      if (part.count < 2) continue;
      const d = distance(eye, cellCenter(part));
      if (d < best) {
        best = d;
        nearest = part;
      }
    }
    return nearest;
  }

  /** Frame a group's padded bounds from above, including coincident mounts. */
  function zoomToCell(cell) {
    const viewer = layerState._viewer;
    if (!viewer || viewHeldBy(viewer)) return;
    const camera = cameraOf(viewer);
    const pose = camera.pose();
    const tanHalfY = Math.tan((pose.fovy || Math.PI / 3) / 2);
    const canvas = canvasOf(viewer);
    const height = canvas?.clientHeight || canvas?.height || 1;
    // Half the range where cells stop grouping, so even coincident mounts split.
    const closeRange =
      (VIEW_MIN_CELL_M * height) / (4 * VIEW_CELL_PX * tanHalfY);
    const tanHalfX = tanHalfY * (pose.aspectRatio || 1);
    // Range where a cell's ground extent, times `pad`, fits the frame at the
    // depth of its highest mount above the bounds centre.
    const extentRange = (target, bounds, pad = 1) => {
      const { halfWidthM, halfHeightM } = cellHalfExtents(target);
      const rise = Math.max(0, target.high - toLonLatH(bounds.center).height);
      return (
        rise + pad * Math.max(halfWidthM / tanHalfX, halfHeightM / tanHalfY)
      );
    };
    // The sphere fit spans the wider side, so a very wide window also needs the extent.
    const fitRange = (target, bounds) =>
      Math.max(
        closeRange,
        rangeForBoundingSphere(viewer, bounds.radius),
        extentRange(target, bounds, 1.2),
      );
    // Approach long groups in halves so every click gets closer.
    const halfway = (bounds) =>
      pose.position ? distance(pose.position, bounds.center) / 2 : Infinity;
    let bounds = cellBounds(cell);
    let range = Math.min(halfway(bounds), fitRange(cell, bounds));
    // If the group overflows the frame at that range, approach its nearest counted cell.
    if (range < extentRange(cell, bounds)) {
      const part = nearestPart(cell, pose.position);
      bounds = cellBounds(part);
      range = Math.min(halfway(bounds), fitRange(part, bounds));
    }
    camera.flyToBounds(bounds, {
      offset: { heading: 0, pitch: -Math.PI / 2, range },
      durationS: 1.2,
      easing: 'cubicInOut',
    });
  }

  function focusCamera(cameraId, duration = 2.2) {
    return focusCctvRecord(
      layerState._viewer,
      layerState._recordById.get(cameraId),
      duration,
    );
  }

  /**
   * Advances to the next camera if auto-hop is enabled and the hop interval
   * has elapsed. If the viewer has panned to a new region since the last hop,
   * snaps to the nearest camera instead of cycling sequentially.
   * @param {number} nowMs - Current timestamp in milliseconds.
   */

  function maybeAutoHop(nowMs) {
    if (
      !layerState._autoHop ||
      layerState._autoHopSuspended ||
      (previewedCameraId && previewedCameraId === layerState._activeCameraId) ||
      !layerState._enabled ||
      layerState._records.length < 2
    )
      return;
    if (nowMs - layerState._lastHopAt < layerState._autoHopSec * 1000) return;

    const viewKey = parts.model.currentViewContext();
    const viewChanged = viewKey !== layerState._lastViewContext;
    layerState._lastViewContext = viewKey;

    const listed = layerState._nearbyArea?.order;
    let nextId = null;
    layerState._lastHopAt = nowMs;
    if (listed) {
      const activeId = layerState._activeCameraId;
      const index = listed.indexOf(activeId);
      for (let step = 1; step <= listed.length; step++) {
        const id = listed[(index + step) % listed.length];
        if (id !== activeId && layerState._recordById.has(id)) {
          nextId = id;
          break;
        }
      }
      if (!nextId) return;
    } else {
      if (viewChanged) nextId = nearestCameraIdToViewer();
      if (!nextId || nextId === layerState._activeCameraId) {
        const nextIdx = cycleIndex(
          layerState._records.findIndex(
            (record) => record.camera.id === layerState._activeCameraId,
          ),
          1,
          layerState._records.length,
        );
        nextId = layerState._records[nextIdx].camera.id;
      }
    }
    quietly(() => parts.selection.setActiveCamera(nextId));
  }

  return {
    nearestCameraIdToPoint,
    nearestCameraIdToViewer,
    openingCameraId,
    reopenNearestCamera,
    focusCctvRecord,
    zoomToCell,
    focusCamera,
    setNearbyArea,
    canStepNearby,
    stepNearbyCamera,
    maybeAutoHop,
    setPreviewedCamera,
    quietly,
    cctvCycleIndex: cycleIndex,
  };
}
