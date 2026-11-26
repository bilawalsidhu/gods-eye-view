import { createCountMarkers } from './countMarkers.js';
import { addCellCamera, createCameraCell } from '../../data/cctvCellCounts.js';
import { isHeadingEstimated } from './headingConfidence.js';
import {
  ACTIVE_CAMERA_COLOR,
  CAMERA_ICON,
  CAMERA_ICON_PX,
  COUNT_MERGE_GAP_PX,
  VIEW_SITE_M,
  IDLE_CAMERA_ICON,
  IDLE_CAMERA_COLOR,
  LIVE_CAMERA_COLOR,
  ACTIVE_COVERAGE_CENTER,
  IDLE_COVERAGE_CENTER_MUTED,
  ACTIVE_COVERAGE_CENTER_DEPTHFAIL,
  ACTIVE_COVERAGE_EDGE,
  IDLE_COVERAGE_EDGE_MUTED,
  ACTIVE_COVERAGE_EDGE_DEPTHFAIL,
  IDLE_COVERAGE_COLOR,
  VIEW_CELL_PX,
  VIEW_ICON_MARGIN,
  VIEW_MIN_CELL_M,
  VIEW_SITE_SPREAD_PX,
  VIEW_GROUND_READS,
} from './policy.js';
import { createIconBook } from '../../render/motion/iconBook.js';
import { frustumVolumeGeometryData } from '../../data/cctvViewshed.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findGlobe,
  findQuery,
} from '../../render/rendererOf.js';
import { heightsOf } from '../../queries/heights.js';
import {
  fromDegrees,
  fromDegreesInto,
  toLonLatH,
  WGS84,
} from '../../geo/ellipsoid.js';
import { eastNorthUp } from '../../geo/frames.js';
import { poseProjector } from '../../geo/frustum.js';
import { horizonFrom } from '../../geo/horizon.js';
import { add, distance, dot, scale, sub } from '../../geo/vector.js';

const IDLE_ICON_STYLE = { image: IDLE_CAMERA_ICON, color: IDLE_CAMERA_COLOR };
const ACTIVE_ICON_STYLE = { image: CAMERA_ICON, color: ACTIVE_CAMERA_COLOR };
const LIVE_ICON_STYLE = { image: CAMERA_ICON, color: LIVE_CAMERA_COLOR };

/** An RGBA colour with another alpha. */
const withAlpha = (color, alpha) => [color[0], color[1], color[2], alpha];

/** Icon sets made so far, by every layer: set ids unique to each. */
let iconSets = 0;

/** A point's coordinates, as an item keeps them. */
const copyPoint = (p) => ({ x: p.x, y: p.y, z: p.z });

/** Whether two points are the same, coordinate for coordinate. */
const samePoint = (a, b) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;

/** Degrees to radians. */
const toRadians = (degrees) => (degrees * Math.PI) / 180;

const CAMERA_SCALE_BY_DISTANCE = Object.freeze({
  near: 350,
  nearValue: 1.25,
  far: 4_000_000,
  farValue: 0.42,
});

/**
 * The translucent frustum volume of one camera, as a mesh item: the same 5
 * points the wireframe draws (frustumVolumeGeometryData), in the
 * east-north-up frame at the mount. Unlit flat colour, both faces visible
 * (the viewer is routinely inside or behind a cone); its set is never
 * pickable (clicks fall through to the icon/wireframe/plane, whose pick
 * semantics are established).
 * @param {string} id - Item id.
 * @param {Object} positions - frustumCartesians shape.
 * @param {number[]} color - Per-camera fill colour (already alpha'd).
 */
function frustumVolumeItem(id, positions, color) {
  const { positions: flat, indices } = frustumVolumeGeometryData(positions);
  const origin = positions.mount;
  const frame = eastNorthUp(origin);
  const local = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i += 3) {
    const dx = flat[i] - origin.x;
    const dy = flat[i + 1] - origin.y;
    const dz = flat[i + 2] - origin.z;
    local[i] = dx * frame.x.x + dy * frame.x.y + dz * frame.x.z;
    local[i + 1] = dx * frame.y.x + dy * frame.y.y + dz * frame.y.z;
    local[i + 2] = dx * frame.z.x + dy * frame.z.y + dz * frame.z.z;
  }
  return {
    id,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    positions: local,
    indices,
    color,
    flat: true,
  };
}

/** FNV-1a over a camera id: a stable, well-spread order for crowded cells. */
function idHash(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * The catalog's camera icons: an icon draw set, and the book the layer
   * reads them back from (`render/motion/iconBook.js`), each item a camera
   * by its id. Cameras hold still, so each item's motion is a hold at its
   * mount. Items draw depth-test-free (field-test fix 2026-07-06: the old
   * finite depth-test distance re-engaged at far zoom, where the COARSE
   * far-LOD Google-3D mesh sits above the true ground and swallowed
   * ground-anchored icons); the set culls the far side of the globe and
   * refreshHorizonCulling thins the rest.
   * The set stacks under the other sprite layers (`spriteDrawOrder`).
   * @param {object} viewer The layer's viewer.
   * @returns {string} The icon set's id.
   */
  function createCameraIcons(viewer) {
    // A re-init against a new viewer replaces the icons; the old ones go.
    destroyCameraIcons();
    const set = drawOf(viewer).icons({
      id: `cctv:${++iconSets}:icons`,
      horizonCull: true,
      // Hidden until enable() has thinned and culled them
      // (refreshHorizonCulling, then refreshCoverageStyles shows the set):
      // shown from the start, every camera in the catalogue drew while the
      // layer waited on its health check.
      show: false,
      drawOrder: services.sprites?.spriteDrawOrder?.('cctv') ?? 0,
    });
    // Columns of no rows put the set's host in the scene now, rather than
    // with its first camera.
    set.setColumns?.({ ids: [] });
    layerState._icons = createIconBook(set);
    layerState._counts = createCountMarkers(
      services.overlays?.registerWorldOverlayPaintLane,
      `cctv:${iconSets}:counts`,
      refreshViewFromCounts,
      services.overlays?.keyholeAlpha,
    );
    return set.id;
  }

  /** Let the icon draw set go, whichever viewer the caller tears down. */
  function destroyCameraIcons() {
    layerState._icons?.dispose();
    layerState._icons = null;
    layerState._counts?.dispose();
    layerState._counts = null;
  }

  /** The icon item a camera record draws, idle and shown, at its position. */
  function cameraIconItem(record) {
    const id = record.camera.id;
    return {
      id,
      pos: copyPoint(record.spreadPosition ?? record.position),
      ...cameraIconStyleFor(record),
      size: [CAMERA_ICON_PX, CAMERA_ICON_PX],
      scale: 1,
      scaleByDistance: CAMERA_SCALE_BY_DISTANCE,
      disableDepthTest: Infinity,
      motion: { kind: 'hold' },
      meta: { layer: 'cctv', id },
      show: true,
    };
  }

  /**
   * A camera's icon item with `fields` changed, to write with the pass's
   * others in one go (`writeCameraIcons`); null when none of them changes
   * or it has no icon, so a large catalog writes only what changed.
   */
  function patchedCameraIcon(id, fields) {
    const item = layerState._icons?.item(id);
    if (!item) return null;
    for (const key in fields)
      if (item[key] !== fields[key]) return { ...item, ...fields };
    return null;
  }

  /** Write a pass's changed icons, in one write to the set. */
  function writeCameraIcons(items) {
    if (items.length) layerState._icons?.putMany(items);
  }

  /** Add a camera record's icon, idle and shown, once it has a position. */
  function addCameraIcon(record) {
    const icons = layerState._icons;
    if (!icons || !record.position) return;
    icons.put(cameraIconItem(record));
  }

  /** Hold a camera's icon at its record's current position. */
  function moveCameraIcon(record) {
    const icons = layerState._icons;
    if (!icons || !record.position) return;
    // A camera drawn beside its mount mates keeps its offset from the mount.
    if (record.spreadOffset)
      record.spreadPosition = add(record.position, record.spreadOffset);
    const pos = record.spreadPosition ?? record.position;
    const item = icons.item(record.camera.id);
    // A camera whose icon waited for a position is drawn now.
    if (!item) {
      icons.put(cameraIconItem(record));
      return;
    }
    if (samePoint(item.pos, pos)) return;
    icons.put({ ...item, pos: copyPoint(pos) });
  }

  /** Select the sprite and tint together when a camera changes state. */
  function cameraIconStyleFor(record) {
    if (record.camera.id === layerState._activeCameraId)
      return ACTIVE_ICON_STYLE;
    if (parts.model.isVideoFeedCamera(record.camera)) return LIVE_ICON_STYLE;
    return IDLE_ICON_STYLE;
  }

  const {
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
    nearFarScalarValueAtDistance,
  } = services.focus;
  const iconScaleAt = (range) =>
    nearFarScalarValueAtDistance?.(CAMERA_SCALE_BY_DISTANCE, range) ?? 1;

  /**
   * Focus modulation rides the layer's existing animation loop; no additional
   * scene listener is installed. Camera and count icons share the fade. Coverage
   * geometry and monitor-plane styling retain their established cadence.
   */

  function refreshCctvFocusStyles(nowMs) {
    nowMs = focusNowMs(nowMs);
    const target = getFocusTarget();
    if (
      !layerState._enabled ||
      !layerState._viewer ||
      !focusPassIsNeeded(target, layerState._activeFocusStyleCount)
    )
      return;
    if (nowMs - layerState._lastFocusStyleAt < 80) return;
    layerState._lastFocusStyleAt = nowMs;
    const query = findQuery(layerState._viewer);
    const eye = findCamera(layerState._viewer)?.pose()?.position;
    if (!query || !eye) return;
    const result = applyCctvFocusDeemphasis({
      records: layerState._records,
      target,
      previousActiveCount: layerState._activeFocusStyleCount,
      nowMs,
      screenPositionFor: (position) => query.project(position),
      cameraDistanceFor: (position) => distance(eye, position),
    });
    layerState._activeFocusStyleCount = result.activeCount;
  }

  /**
   * Apply the gated CCTV focus pass through the set's focus column (the shader
   * multiplies it into the base color's alpha).
   * @param {object} input
   * @param {object} [input.icons] The icon book (defaults to the layer's).
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyCctvFocusDeemphasis({
    records,
    icons = layerState._icons,
    target,
    previousActiveCount = 0,
    nowMs,
    screenPositionFor,
    cameraDistanceFor,
    params,
  }) {
    if (!focusPassIsNeeded(target, previousActiveCount)) {
      return { writes: 0, transitioning: false, activeCount: 0, ran: false };
    }
    let writes = 0;
    let transitioning = false;
    let activeCount = 0;
    /**
     * A changed focus factor for an icon or count. CCTV publishes no tracked
     * focus target, so every icon is ambient.
     */
    function changedFocus(owner, position, shown, width, height, current) {
      const focus = advanceSpriteFocus(owner, {
        // Keep hidden owners in the active count until their dim alpha clears,
        // so the focus pass keeps running while they recover.
        screenPosition: shown && position ? screenPositionFor(position) : null,
        cameraDistance: position ? cameraDistanceFor(position) : Number.NaN,
        nowMs,
        target,
        params,
        spriteHalfWidthPx: width / 2,
        spriteHalfHeightPx: height / 2,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount++;
      if (!focusAlphaNeedsWrite(current, focus.factor, params)) return null;
      writes++;
      return focus.factor;
    }
    for (const record of records || []) {
      const id = record.camera?.id;
      const item = icons?.item(id);
      if (!item) continue;
      const scale = item.scale ?? 1;
      const factor = changedFocus(
        item.meta,
        record.position,
        item.show !== false,
        item.size[0] * scale,
        item.size[1] * scale,
        icons.focus(id),
      );
      if (factor !== null) icons.setFocus(id, factor);
    }
    const counts = layerState._counts;
    const iconWrites = writes;
    for (const marker of counts?.markers ?? []) {
      const factor = changedFocus(
        marker,
        marker.pos,
        true,
        marker.width,
        marker.height,
        marker.focus,
      );
      if (factor !== null) marker.focus = factor;
    }
    if (writes > iconWrites) counts.requestPaint();
    return { writes, transitioning, activeCount, ran: true };
  }

  /** During camera motion the timer and settle pass refresh the counts. */
  function refreshViewFromCounts() {
    if (!layerState._cameraMoving) refreshHorizonCulling();
  }

  /**
   * Cull far-side cameras on the CPU because the hidden globe writes no depth.
   * Group the rest by ground cell. _viewRecords holds the active camera and
   * every nearby icon outside a count for geometry and cards. Cells smaller
   * than VIEW_MIN_CELL_M do not form groups. _pickerRecords adds the
   * best-ranked camera of each visible cell. Both arrays keep their identity
   * while their contents are unchanged.
   *
   * Runs on camera settle, throttled during motion, on resize, enable and
   * activation changes — never per frame.
   * @returns {boolean} Whether the shown set or the picker list changed.
   */

  function refreshHorizonCulling() {
    if (
      !layerState._enabled ||
      !layerState._viewer ||
      !layerState._records.length
    )
      return false;
    const pose = findCamera(layerState._viewer)?.pose();
    if (!pose?.position) return false;
    const canvas = canvasOf(layerState._viewer);
    const width = canvas?.clientWidth || canvas?.width || 0;
    const height = canvas?.clientHeight || canvas?.height || 0;
    const minX = -width * VIEW_ICON_MARGIN;
    const maxX = width * (1 + VIEW_ICON_MARGIN);
    const minY = -height * VIEW_ICON_MARGIN;
    const maxY = height * (1 + VIEW_ICON_MARGIN);
    // Ground metres one pixel covers per metre of distance from the viewer.
    const fovy = Number.isFinite(pose.fovy) ? pose.fovy : Math.PI / 3;
    const metresPerPixelPerMetre =
      (2 * Math.tan(fovy / 2)) / Math.max(1, height);
    const viewer = pose.position;
    // The renderer's horizon test (geo/horizon.js), inlined: this loop
    // visits every camera in the catalog.
    const inverseRadii = WGS84.oneOverRadii;
    const cx = viewer.x * inverseRadii.x;
    const cy = viewer.y * inverseRadii.y;
    const cz = viewer.z * inverseRadii.z;
    const limbSquared = cx * cx + cy * cy + cz * cz - 1;
    const activeId = layerState._activeCameraId;
    const project = screenProjector(pose, width, height);
    const pass = (layerState._viewPassId = (layerState._viewPassId || 0) + 1);
    const shown = [];
    const picker = [];
    const cells = new Map();
    const visibleCells = [];
    // Drawn terrain where the globe is the surface. The photoreal stack has
    // no reader, and unloaded tiles return a non-finite height.
    const heights = heightsOf(layerState._viewer);
    const globe = findGlobe(layerState._viewer);
    const groundHeight =
      findQuery(layerState._viewer) && globe?.isGlobeVisible?.() === true
        ? (lon, lat) => heights.now({ lon, lat }, { against: 'terrain' })
        : null;
    const surface = globe?.surfaceVersion?.() ?? 0;
    const terrainSettled = globe?.isSettled?.('terrain') ?? true;
    let groundReads = groundHeight ? VIEW_GROUND_READS : 0;
    let offscreenReads = groundReads / 2;
    let eyeGround;
    const column = { x: 0, y: 0, z: 0 };
    const inReadWindow = (s) =>
      s &&
      s.x >= -width &&
      s.x <= 2 * width &&
      s.y >= -height &&
      s.y <= 2 * height;
    const regrounded = [];
    for (const record of layerState._records) {
      const position = record.position;
      if (!position) continue;
      const vx = position.x * inverseRadii.x - cx;
      const vy = position.y * inverseRadii.y - cy;
      const vz = position.z * inverseRadii.z - cz;
      const vtDotVc = -(vx * cx + vy * cy + vz * cz);
      if (
        limbSquared < 0
          ? vtDotVc > 0
          : vtDotVc > limbSquared &&
            (vtDotVc * vtDotVc) / (vx * vx + vy * vy + vz * vz) > limbSquared
      )
        continue;
      let screen = project(position);
      let range = distance(position, viewer);
      // Missing, unresolved and fallback priors can put a mount kilometres
      // below the terrain, shifting its projection and inflating its cell.
      // Read nearby mounts again from under half the range, on finer terrain
      // after loading, or on a different surface.
      const prior = record.groundPrior;
      const drawn = prior?.source === 'drawn-terrain';
      const unanswered =
        !Number.isFinite(prior?.ellipsoid) || prior.source === 'geoid-fallback';
      if (
        groundReads > 0 &&
        !record.regroundPending &&
        (unanswered ||
          (drawn &&
            (prior.rangeM > 2 * range ||
              prior.surface !== surface ||
              (!prior.settled && terrainSettled))))
      ) {
        let probe = inReadWindow(screen) ? screen : null;
        if (!probe && unanswered) {
          // Its height is a guess. Try the ground under the eye instead.
          if (eyeGround === undefined) {
            const eye = toLonLatH(viewer);
            eyeGround = eye ? (groundHeight(eye.lon, eye.lat) ?? null) : null;
            groundReads--;
          }
          if (Number.isFinite(eyeGround)) {
            fromDegreesInto(
              record.camera.lon,
              record.camera.lat,
              eyeGround + (record.camera.mountHeightM || 0),
              column,
            );
            const at = project(column);
            if (inReadWindow(at)) probe = at;
          }
        }
        const onScreen =
          probe &&
          probe.x >= 0 &&
          probe.x <= width &&
          probe.y >= 0 &&
          probe.y <= height;
        if (probe && groundReads > 0 && (onScreen || offscreenReads > 0)) {
          groundReads--;
          if (!onScreen) offscreenReads--;
          const ground = groundHeight(record.camera.lon, record.camera.lat);
          if (Number.isFinite(ground)) {
            const read = { rangeM: range, surface, settled: terrainSettled };
            if (drawn && Math.abs(ground - prior.ellipsoid) < 1)
              Object.assign(prior, read);
            else if (record.frustumGeometry) {
              // Recomputing geometry writes draw sets after this pass.
              record.regroundPending = true;
              regrounded.push([record, ground, read]);
            } else parts.ground.adoptDrawnGround(record, ground, read);
          }
        }
        // The probe reuses the projector's result, and the mount may have moved.
        screen = project(position);
        range = distance(position, viewer);
      }
      const nearScreen =
        screen &&
        screen.x >= minX &&
        screen.x <= maxX &&
        screen.y >= minY &&
        screen.y <= maxY;
      const cellM = VIEW_CELL_PX * metresPerPixelPerMetre * range;
      if (record.camera.id === activeId) {
        if (!nearScreen) continue;
        record.viewPass = record.pickerPass = pass;
        shown.push(record);
        picker.push(record);
        continue;
      }
      if (!(cellM >= VIEW_MIN_CELL_M)) {
        if (!nearScreen) continue;
        // Too close to group, but a count beside it can still take it in.
        const cell = createCameraCell(`near:${record.camera.id}`);
        addCellCamera(cell, record.camera);
        cell.iconPx = CAMERA_ICON_PX * iconScaleAt(range);
        cell.winner = record;
        cell.rank = 0;
        record.viewCell = cell;
        visibleCells.push(cell);
        continue;
      }
      const key = worldCellKey(record, cellM);
      let cell = cells.get(key);
      if (!cell) {
        cell = createCameraCell(key);
        cells.set(key, cell);
      }
      addCellCamera(cell, record.camera);
      if (cell.count === 1) cell.iconPx = CAMERA_ICON_PX * iconScaleAt(range);
      record.viewCell = cell;
      if (!nearScreen) continue;
      // The picker ranks only candidates that were in its padded viewport.
      if (!cell.winner) visibleCells.push(cell);
      const rank = viewRank(record);
      if (rank < cell.rank) {
        cell.winner = record;
        cell.rank = rank;
      }
    }
    // Check each mount mate against counts where its icon will be drawn.
    const lone = visibleCells.filter((cell) => cell.count === 1);
    spreadSharedMounts(
      shown.concat(lone.map((cell) => cell.winner)),
      pose,
      metresPerPixelPerMetre,
      pass,
    );
    for (const cell of lone)
      cell.offsetPx =
        cell.winner.spreadPass === pass ? cell.winner.spreadPx : 0;
    // A count stands on the drawn terrain too: its cell may be too far for
    // its cameras to have been read. Marks each lone camera that a count
    // marker beside it has taken in.
    layerState._counts?.update(visibleCells, project, groundHeight);
    for (const cell of visibleCells) {
      const record = cell.winner;
      picker.push(record);
      record.pickerPass = pass;
      if (cell.count === 1 && !cell.absorbed) {
        record.viewPass = pass;
        shown.push(record);
      }
    }
    clearActiveOfCounts(project, pose, metresPerPixelPerMetre, pass);
    const writes = [];
    let coverageChanged = false;
    let cardsChanged = false;
    for (const record of layerState._records) {
      const cell = record.viewCell;
      record.viewCell = null;
      const grouped = Boolean(
        cell?.winner && (cell.count > 1 || cell.absorbed),
      );
      if (grouped !== !!record.viewGrouped) {
        const id = record.camera.id;
        coverageChanged ||= layerState._coverageCohort?.has(id);
        cardsChanged ||=
          layerState._cardIds?.has(id) || layerState._hoverCardId === id;
      }
      record.viewGrouped = grouped;
      const fields = { show: record.viewPass === pass };
      if (record.spreadPass === pass) {
        const drawn = layerState._icons?.item(record.camera.id)?.pos;
        if (!drawn || !samePoint(drawn, record.spreadPosition))
          fields.pos = copyPoint(record.spreadPosition);
      } else if (record.spreadPosition) {
        // No longer beside a mount mate: back onto its own position.
        record.spreadOffset = null;
        record.spreadPosition = null;
        fields.pos = copyPoint(record.position);
      }
      const item = patchedCameraIcon(record.camera.id, fields);
      if (item) writes.push(item);
    }
    writeCameraIcons(writes);
    if (regrounded.length) queueMicrotask(() => reground(regrounded));
    const previous = layerState._viewRecords;
    const changed =
      previous.length !== shown.length ||
      previous.some((record) => record.viewPass !== pass);
    if (changed) layerState._viewRecords = shown;
    const oldPicker = layerState._pickerRecords ?? [];
    const pickerChanged =
      picker.length !== oldPicker.length ||
      oldPicker.some((record) => record.pickerPass !== pass);
    if (pickerChanged) layerState._pickerRecords = picker;
    if (coverageChanged) refreshCoverageStyles();
    if (cardsChanged) parts.cards.pushAmbientCardEntries();
    return changed || pickerChanged;
  }

  /**
   * Cameras that have geometry take the drawn terrain after the pass that
   * read it, then the view is passed again from their new positions.
   */
  function reground(entries) {
    let changed = false;
    for (const [record, ground, read] of entries) {
      record.regroundPending = false;
      changed =
        parts.ground.adoptDrawnGround(record, ground, read) !== null || changed;
    }
    if (!changed) return;
    if (refreshHorizonCulling()) parts.geometryQueue.enqueueViewGeometry();
    parts.presentation.notifyListeners();
  }

  /**
   * Cameras on one mount would draw as one icon with several callouts. Among
   * icon candidates, those within VIEW_SITE_M horizontally get draw positions
   * side by side in id order, `VIEW_SITE_SPREAD_PX` apart on screen. A mate
   * absorbed by a count keeps its place in the row. Geometry and cards stay
   * on the mount.
   */
  function spreadSharedMounts(shown, pose, metresPerPixelPerMetre, pass) {
    const { right, direction, position: eye } = pose;
    if (!right || !direction || shown.length < 2) return;
    const grid = new Map();
    const mounts = [];
    const axes = eastNorthUp(eye);
    for (const record of shown) {
      // Sea-level coordinates compare horizontal distance across longitude
      // and latitude boundaries, including the antimeridian.
      const p = fromDegrees(record.camera.lon, record.camera.lat, 0);
      const col = Math.floor(dot(p, axes.x) / VIEW_SITE_M);
      const row = Math.floor(dot(p, axes.y) / VIEW_SITE_M);
      let mount;
      for (let i = col - 1; !mount && i <= col + 1; i++)
        for (let j = row - 1; !mount && j <= row + 1; j++)
          mount = grid
            .get(`${i}:${j}`)
            ?.find((site) => distance(p, site.p) <= VIEW_SITE_M);
      if (!mount) {
        mount = { p, mates: [] };
        mounts.push(mount);
        const key = `${col}:${row}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(mount);
      }
      mount.mates.push(record);
    }
    for (const { mates } of mounts) {
      if (mates.length < 2) continue;
      mates.sort((a, b) => a.camera.id.localeCompare(b.camera.id));
      for (let i = 0; i < mates.length; i++) {
        const record = mates[i];
        const p = record.position;
        // A pixel's width on the ground grows with depth along the view.
        const depth =
          (p.x - eye.x) * direction.x +
          (p.y - eye.y) * direction.y +
          (p.z - eye.z) * direction.z;
        const px = (i - (mates.length - 1) / 2) * VIEW_SITE_SPREAD_PX;
        record.spreadPx = px;
        const metres = px * metresPerPixelPerMetre * depth;
        record.spreadOffset = scale(right, metres);
        record.spreadPosition = add(p, record.spreadOffset);
        record.spreadPass = pass;
      }
    }
  }

  /** Only counts visible outside the HUD push the active icon aside. */
  function clearActiveOfCounts(project, pose, metresPerPixelPerMetre, pass) {
    const markers = layerState._counts?.markers;
    for (const marker of markers ?? []) marker.besideActive = false;
    if (!layerState._activeCameraId) return;
    const record = layerState._recordById.get(layerState._activeCameraId);
    if (
      record?.viewPass !== pass ||
      !markers?.length ||
      !pose.right ||
      !pose.direction
    )
      return;
    const spread = record.spreadPass === pass;
    const p = spread ? record.spreadPosition : record.position;
    const screen = project(p);
    if (!screen) return;
    const { x, y } = screen;
    const half =
      (CAMERA_ICON_PX * 1.25 * iconScaleAt(distance(p, pose.position))) / 2;
    const spans = [];
    for (const marker of markers) {
      const at = project(marker.pos);
      if (
        !at ||
        Math.abs(y - at.y) >= marker.height / 2 + half + COUNT_MERGE_GAP_PX
      )
        continue;
      marker.besideActive = true;
      if (marker.hudHidden) continue;
      const reach = marker.width / 2 + half + COUNT_MERGE_GAP_PX;
      spans.push([at.x - reach, at.x + reach]);
    }
    // Leave the entire overlapping interval, including an adjacent count.
    spans.sort((a, b) => a[0] - b[0]);
    let left = Infinity,
      right = -Infinity;
    for (const [start, end] of spans) {
      if (start >= right) {
        if (left < x && x < right) break;
        left = start;
        right = end;
      } else right = Math.max(right, end);
    }
    if (!(left < x && x < right)) return;
    const shift = x - left < right - x ? left - x : right - x;
    const depth = dot(sub(p, pose.position), pose.direction);
    const offset = scale(pose.right, shift * metresPerPixelPerMetre * depth);
    record.spreadOffset = spread ? add(record.spreadOffset, offset) : offset;
    record.spreadPosition = add(record.position, record.spreadOffset);
    record.spreadPass = pass;
  }

  /**
   * Canvas coordinates for world positions, from the eye's pose by the
   * renderer's perspective projection (geo/frustum.js): one pose read per
   * pass rather than a renderer projection per point, which dominated the
   * pass on a large catalog. Null behind the eye or before its near plane.
   * A pose with no perspective field of view is projected by the renderer,
   * point by point.
   * @returns {(position: {x: number, y: number, z: number}) =>
   *   ({x: number, y: number}|null)}
   */
  function screenProjector(pose, width, height) {
    if (Number.isFinite(pose.fovy) && Number.isFinite(pose.aspectRatio)) {
      return poseProjector(pose, width, height, layerState._scratchViewScreen);
    }
    const query = findQuery(layerState._viewer);
    return (position) => query?.project(position) ?? null;
  }

  /**
   * A grid cell fixed to the ground: `cellM` rounded up to a power of two
   * metres, so the cell (and its winner) only changes when the camera's
   * distance crosses a doubling: a level pan keeps it, a tilted pan or a zoom
   * can move cameras near the edge of a step to the next one.
   */
  function worldCellKey(record, cellM) {
    const level = Math.ceil(Math.log2(cellM));
    const { lat, lon } = record.camera;
    // A camera's key changes only with the level (or an edited position), so
    // it is kept per level.
    if (
      record.viewCellLevel === level &&
      record.viewCellLat === lat &&
      record.viewCellLon === lon
    )
      return record.viewCellKey;
    const latStep = 2 ** level / 111_320;
    const row = Math.floor(lat / latStep);
    const rowLat = toRadians((row + 0.5) * latStep);
    const lonStep = latStep / Math.max(0.05, Math.cos(rowLat));
    record.viewCellLevel = level;
    record.viewCellLat = lat;
    record.viewCellLon = lon;
    record.viewCellKey = `${level}:${row}:${Math.floor(lon / lonStep)}`;
    return record.viewCellKey;
  }

  /** Lower ranks win a crowded cell: healthy feeds first, then a stable id order. */
  function viewRank(record) {
    const status = layerState._healthById.get(record.camera.id)?.status;
    const tier =
      status === 'ok'
        ? 0
        : status === 'degraded'
          ? 1
          : status === 'offline'
            ? 3
            : 2;
    record.viewHash ??= idHash(record.camera.id);
    return tier * 2 ** 32 + record.viewHash;
  }

  /**
   * Hides every per-record CCTV visual without recomputing coverage membership or
   * styles. Disabling makes every visibility branch false, so a direct sweep is
   * sufficient; live viewshed primitives still require explicit destruction.
   *
   * @param {Object[]} records CCTV runtime records.
   * @param {(record: Object) => void} destroyVolume Viewshed teardown callback.
   * @param {string|null} [activeCameraId=null] Active camera whose activation probe must be re-armed.
   */

  function hideCctvRecordVisuals(
    records,
    destroyVolume,
    activeCameraId = null,
  ) {
    for (const record of Array.isArray(records) ? records : []) {
      if (record) {
        record.probeClampRangeM = null;
        // A probe still to answer no longer lands.
        record.probeToken = (record.probeToken || 0) + 1;
        if (record.camera?.id === activeCameraId) record.activationDone = false;
      }
      for (const entity of record?.coverageEntities || []) entity.show = false;
      parts.drawSets.writeLines(record?.coverageEntities);
      if (record?.viewshedVolume) destroyVolume?.(record);
      const plane = record?.projection?.plane;
      if (plane?.show) {
        plane.show = false;
        parts.drawSets.writePlane(plane);
      }
    }
  }

  function hideCctvVisuals() {
    hideCctvRecordVisuals(
      layerState._records,
      destroyViewshedVolume,
      layerState._activeCameraId,
    );
    parts.projection.clearProjectionOverlay();
    if (layerState._icons) layerState._icons.show = false;
    layerState._counts?.hide();
    parts.projection.pauseInactiveProjectionFeeds(null);
  }

  /** Applies coverage visibility/style state and lazily builds eligible sets. */

  function refreshCoverageStyles() {
    const activeRecord = parts.selection.getActiveRecord();
    parts.geometry.ensureActiveCoverageEntities(activeRecord);
    const activeId = activeRecord?.camera.id || null;
    const cohort = parts.geometry.buildCoverageVisibleSet(activeRecord);
    layerState._coverageCohort = cohort;
    const coverageVisible = new Set();
    for (const id of cohort) {
      if (!layerState._recordById.get(id)?.viewGrouped) coverageVisible.add(id);
    }
    // Drawn coverage needs geometry too (geometryQueue's working set).
    layerState._coverageVisibleIds = coverageVisible;
    const coverageOn = layerState._coverageMode !== 'off';
    const viewshedOn = layerState._coverageMode === 'viewshed';
    if (coverageOn) {
      parts.geometry.ensureVisibleCoverageEntities(
        layerState._records,
        coverageVisible,
      );
    }
    // Only changed icons are written, in one go after the pass, so across a
    // large catalog only the changed rows upload.
    const restyled = [];
    for (const record of layerState._records) {
      const isActive = record.camera.id === activeId;
      const icon = patchedCameraIcon(record.camera.id, {
        ...cameraIconStyleFor(record),
        scale: isActive ? 1.25 : 1.0,
      });
      if (icon) restyled.push(icon);

      if (
        layerState._enabled &&
        isActive &&
        !parts.model.isBrowserOverlayCamera(record.camera) &&
        (layerState._showProjection ||
          parts.model.isVideoFeedCamera(record.camera))
      ) {
        parts.projection.ensureProjectionRuntime(record);
      }
      // One live plane in the world at a time (§2c): only the active camera's
      // far cap carries the monitor plane; idle neighbors get the faint
      // wireframe only.
      const planeShowing = !!(
        layerState._enabled &&
        layerState._showProjection &&
        isActive &&
        !parts.model.isBrowserOverlayCamera(record.camera)
      );

      const inVisibleSet = coverageVisible.has(record.camera.id);
      // A synthetic bearing (headingConfidence 'low', no human calibration)
      // draws its wireframe dashed so a guessed facing is visibly provisional
      // rather than rendering identically to a surveyed one (#639). Colors,
      // widths, and the active/idle emphasis are unchanged.
      const bearingEstimated = isHeadingEstimated(record.camera);
      for (const entity of record.coverageEntities || []) {
        // The frustum wireframe is part of the projection representation —
        // force it on for the active camera and let it read through geometry
        // via depthFailMaterial (polylines have no disableDepthTestDistance).
        entity.show = !!(
          layerState._enabled &&
          ((coverageOn && inVisibleSet) || planeShowing)
        );
        if (!entity.role) continue;
        // Viewshed mode swaps the cyan/green scheme for the camera's own hue so
        // adjacent cones read as distinct coverage claims (design §3b); the
        // active camera keeps its width/alpha emphasis in both schemes.
        const hue = viewshedOn ? record.viewshedColors || null : null;
        entity.dashed = bearingEstimated;
        if (entity.role === 'cap') {
          entity.color = hue
            ? isActive
              ? hue.lineActive
              : hue.line
            : isActive
              ? ACTIVE_COVERAGE_CENTER
              : IDLE_COVERAGE_CENTER_MUTED;
          entity.widthPx = isActive ? 2.2 : 1.0;
          entity.depthFailColor = planeShowing
            ? hue
              ? withAlpha(hue.line, 0.26)
              : ACTIVE_COVERAGE_CENTER_DEPTHFAIL
            : null;
        } else {
          entity.color = hue
            ? isActive
              ? hue.lineActive
              : withAlpha(hue.line, 0.6)
            : isActive
              ? ACTIVE_COVERAGE_EDGE
              : IDLE_COVERAGE_EDGE_MUTED;
          entity.widthPx = isActive ? 1.8 : 0.9;
          entity.depthFailColor = planeShowing
            ? hue
              ? withAlpha(hue.line, 0.18)
              : ACTIVE_COVERAGE_EDGE_DEPTHFAIL
            : null;
        }
      }
      parts.drawSets.writeLines(record.coverageEntities);

      // Viewshed volume lifecycle: exists iff enabled + viewshed mode + in the
      // visible set. Rebuild on active-tint flips (rare); otherwise leave the
      // primitive alone so idle refreshes never churn geometry.
      const wantVolume = !!(
        layerState._enabled &&
        viewshedOn &&
        inVisibleSet &&
        record.frustumPositions
      );
      if (wantVolume) {
        if (!record.viewshedVolume || record.viewshedActiveTint !== isActive) {
          rebuildViewshedVolume(record, isActive);
        }
      } else if (record.viewshedVolume) {
        destroyViewshedVolume(record);
      }

      if (record.projection) {
        parts.projection.setPlaneVisible(record.projection, planeShowing);
      }
    }

    writeCameraIcons(restyled);
    if (layerState._icons) layerState._icons.show = !!layerState._enabled;
    parts.projection.pauseInactiveProjectionFeeds(activeId);
  }

  /**
   * Reports whether the photorealistic tiles the scene draws have finished
   * loading the tiles in view. Shared mesh-floor sampling is gated on this so
   * a one-shot cell never bakes in a miss from still-streaming tiles.
   *
   * Only the photoreal regime (the globe hidden under the tiles) can be
   * ready: on a globe stack the tiles are hidden, and the shared sampler can
   * only inspect tiles that are drawn, so a sample taken against them would
   * silently miss (Task 5, spec §2). The tiles' readiness is the globe
   * port's (`isSettled('tiles')`), true as well when no tiles are drawn.
   *
   * @returns {boolean} True when the regime is photoreal and its tiles in
   *   view have loaded.
   */

  function projectionTilesReady() {
    const globe = layerState._viewer ? findGlobe(layerState._viewer) : null;
    if (!globe || globe.isGlobeVisible?.() !== false) return false;
    return globe.isSettled('tiles') === true;
  }

  /**
   * Converts a computeFrustumGeometry result into the ECEF positions the
   * drawn items consume. Fresh objects per call (geometry updates are rare —
   * slider/save/activation — and items must never share scratch objects).
   * @param {Object} geometry - Result of computeFrustumGeometry.
   * @returns {{ mount: object, capCenter: object, tl: object, tr: object,
   *   br: object, bl: object, label: object }} ECEF points with x, y and z.
   */

  function frustumCartesians(geometry) {
    const at = (p) => fromDegrees(p.lon, p.lat, p.alt);
    return {
      mount: at(geometry.mount),
      capCenter: at(geometry.capCenter),
      tl: at(geometry.corners.tl),
      tr: at(geometry.corners.tr),
      br: at(geometry.corners.br),
      bl: at(geometry.corners.bl),
      label: fromDegrees(
        geometry.topCenter.lon,
        geometry.topCenter.lat,
        geometry.topCenter.alt + 1.2,
      ),
    };
  }

  /**
   * Creates the five lines that visualize a camera's pitched frustum: 4
   * corner rays (mount → far-plane corner) + the closed far-plane rectangle,
   * as line handles the layer restyles and then writes to its coverage set.
   * Item ids use the `cctv-<id>-<role>` scheme in pickIds.js:
   * ray-tl / ray-tr / ray-br / ray-bl / cap.
   * @param {Object} record - Camera record.
   * @returns {Object[]} Array of five coverage line handles.
   */

  function buildCoverageEntities(record) {
    const { camera } = record;
    // Prefer the record's already-refined geometry. Lazy creation commonly
    // happens after the staggered ground pass; recomputing from the catalog
    // prior here would regress the camera to its pre-sampled datum.
    let geometry = record.frustumGeometry;
    let positions = record.frustumPositions;
    if (!geometry || !positions) {
      geometry = parts.geometry.computeFrustumGeometry(
        camera,
        parts.ground.groundPriorAltFor(record),
        record.probeClampRangeM,
      );
      positions = frustumCartesians(geometry);
      record.frustumGeometry = geometry;
      record.frustumPositions = positions;
      record.position = positions.mount;
      moveCameraIcon(record);
    }

    const line = (name, role) => ({
      id: `cctv-${camera.id}-${name}`,
      cameraId: camera.id,
      role,
      positions: null,
      widthPx: 1.2,
      color: IDLE_COVERAGE_COLOR,
      dashed: false,
      depthFailColor: null,
      show: true,
    });
    const entities = [
      line('ray-tl', 'edge'),
      line('ray-tr', 'edge'),
      line('ray-br', 'edge'),
      line('ray-bl', 'edge'),
      line('cap', 'cap'),
    ];
    placeCoverageLines(entities, positions);
    parts.drawSets.writeLines(entities);
    return entities;
  }

  /**
   * Put a camera's five coverage line handles on its frustum positions (not
   * written: the caller writes them).
   * @param {Object[]} entities - The record's coverage handles.
   * @param {Object} positions - frustumCartesians shape.
   */
  function placeCoverageLines(entities, positions) {
    if (!(entities?.length >= 5)) return;
    entities[0].positions = [positions.mount, positions.tl];
    entities[1].positions = [positions.mount, positions.tr];
    entities[2].positions = [positions.mount, positions.br];
    entities[3].positions = [positions.mount, positions.bl];
    entities[4].positions = [
      positions.tl,
      positions.tr,
      positions.br,
      positions.bl,
      positions.tl,
    ];
  }

  /**
   * The activation obstruction probe's one ray cast against the scene: the
   * first surface along the ray from `origin`. The layer's own lines, plane
   * and volumes are not ground, so the cast sees through them.
   * @param {{x: number, y: number, z: number}} origin - ECEF ray origin.
   * @param {{x: number, y: number, z: number}} direction - Unit ECEF direction.
   * @returns {Promise<{x: number, y: number, z: number}|null>} Null as well
   *   when the scene cannot cast rays.
   */

  async function obstructionHit(origin, direction) {
    const query = findQuery(layerState._viewer);
    if (!query) return null;
    return query.rayCast({ origin, direction }, { against: 'surface' });
  }

  /**
   * On a globe map, where the activation probe's axis meets the globe's
   * terrain: `{hit}`, `hit` null on a miss. Null when the globe is not shown
   * (the photoreal stack), where only the surface cast counts.
   * @returns {Promise<{hit: object|null}|null>}
   */
  async function terrainHit(origin, direction) {
    const viewer = layerState._viewer;
    if (findGlobe(viewer)?.isGlobeVisible?.() !== true) return null;
    const query = findQuery(viewer);
    if (!query) return null;
    return {
      hit: await query.rayCast({ origin, direction }, { against: 'terrain' }),
    };
  }

  /** Whether there is a query port to cast the activation probe through. */
  function canPickFromRay() {
    return typeof findQuery(layerState._viewer)?.rayCast === 'function';
  }

  /** Removes the layer's coverage lines from the scene. */
  function removeCoverageEntities() {
    parts.drawSets.clearLines();
  }

  /**
   * The camera a pick (a draw-port `Hit`: `event.hit`, `query.pick`)
   * names: an item of the layer's own sets that its record still draws.
   * @param {{set: string, id: string, meta?: object}|null} hit
   * @returns {string|null} Camera ID, or null if the pick is not a CCTV item.
   */

  function extractPickedCameraId(hit) {
    if (!hit || typeof hit.set !== 'string' || typeof hit.id !== 'string')
      return null;

    // A camera icon: its item id is the upstream camera id, so a sibling
    // may legitimately use the same string. A bare id match is not
    // ownership proof: the layer's own icon set must have drawn the pick.
    const icons = layerState._icons;
    if (icons && hit.set === icons.setId)
      return icons.has(hit.id) && layerState._recordById.has(hit.id)
        ? hit.id
        : null;

    // A coverage line or monitor plane: an item of the layer's own sets
    // that its record still draws.
    const role = parts.drawSets.roleOfSet(hit.set);
    if (!role) return null;
    const value = hit.meta?.cameraId;
    const record =
      typeof value === 'string' ? layerState._recordById.get(value) : null;
    if (!record) return null;
    const owns =
      role === 'coverage'
        ? Boolean(record.coverageEntities?.some((h) => h?.id === hit.id))
        : record.projection?.plane?.id === hit.id ||
          layerState._projectionEntities.some(
            (runtime) =>
              runtime?.cameraId === value && runtime.plane?.id === hit.id,
          );
    return owns ? value : null;
  }

  /**
   * The camera whose icon or coverage is under a screen position (CSS px),
   * from one pick; null when none is, or the pick throws.
   * @param {{x: number, y: number}} position
   * @returns {string|null}
   */
  function pickCameraIdAt(position) {
    if (layerState._counts?.pickedCell(position)) return null;
    let hit = null;
    try {
      hit = findQuery(layerState._viewer)?.pick(position.x, position.y) ?? null;
    } catch {
      hit = null;
    }
    return extractPickedCameraId(hit);
  }

  /**
   * Where the ambient cards can go this pass: the canvas size, and the
   * canvas position of a world point on the near side of the horizon (null
   * behind it or off the projection).
   * @returns {{width: number, height: number,
   *   screenOf: (position: object) => ({x: number, y: number}|null)}}
   */
  function cardView() {
    const viewer = layerState._viewer;
    const canvas = canvasOf(viewer);
    const query = findQuery(viewer);
    const eye = findCamera(viewer)?.pose()?.position;
    const horizon = eye ? horizonFrom(eye) : null;
    return {
      width: canvas?.clientWidth || canvas?.width || 0,
      height: canvas?.clientHeight || canvas?.height || 0,
      screenOf: (position) =>
        query && horizon?.isPointVisible(position)
          ? query.project(position)
          : null,
    };
  }

  /**
   * Removes (and destroys) a record's viewshed volume primitive, if any.
   * @param {Object} record - Camera record.
   */

  function destroyViewshedVolume(record) {
    if (!record) return;
    if (record.viewshedVolume)
      parts.drawSets.removeVolume(record.viewshedVolume);
    record.viewshedVolume = null;
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
    if (
      !layerState._viewer ||
      !record?.frustumPositions ||
      !record.viewshedColors
    ) {
      destroyViewshedVolume(record);
      return;
    }
    const colors = record.viewshedColors;
    const id = `cctv-${record.camera.id}-viewshed`;
    // Replaced where it is: the volume draws in the frame its old one did.
    parts.drawSets.writeVolume(
      frustumVolumeItem(
        id,
        record.frustumPositions,
        isActive ? colors.fillActive : colors.fill,
      ),
    );
    record.viewshedVolume = id;
    record.viewshedActiveTint = !!isActive;
  }

  return {
    projectionTilesReady,
    frustumCartesians,
    buildCoverageEntities,
    placeCoverageLines,
    obstructionHit,
    terrainHit,
    canPickFromRay,
    removeCoverageEntities,
    extractPickedCameraId,
    pickCameraIdAt,
    cardView,
    destroyViewshedVolume,
    rebuildViewshedVolume,
    createCameraIcons,
    destroyCameraIcons,
    addCameraIcon,
    moveCameraIcon,
    refreshCctvFocusStyles,
    applyCctvFocusDeemphasis,
    refreshHorizonCulling,
    hideCctvRecordVisuals,
    hideCctvVisuals,
    refreshCoverageStyles,
  };
}
