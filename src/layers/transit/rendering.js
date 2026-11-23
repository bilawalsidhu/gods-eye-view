import {
  drawOf,
  findCamera,
  findFrame,
  findGlobe,
  findQuery,
} from '../../render/rendererOf.js';
import { poseSignature } from '../../render/camera/poseSignature.js';
import { heightsOf } from '../../queries/heights.js';
import { fromDegreesInto } from '../../geo/ellipsoid.js';
import { Vec3 } from '../../geo/vector.js';
import { viewPlanes } from '../../geo/frustum.js';
import { perspectiveCourseRotation } from '../../data/screenRotation.js';
import {
  PLACED_WAKE_MS,
  updatePlayback,
  applyDisplayCourse,
  playbackMoving,
  syncPlayback,
} from './movement.js';
import {
  SELECTED_ICON_PX,
  haloFrame,
  transitIcon,
} from '../../data/transitIcons.js';
import {
  presetSpriteOutlinePx,
  presetSpriteRgba,
  presetSpriteScale,
  transitStyleProfile,
} from '../../data/transitPresetStyle.js';
import {
  CAMERA_PERCENTAGE_CHANGED,
  MARKER_PIXEL_SIZE,
  ROTATION_REFRESH_MS,
  VISIBILITY_REFRESH_MS,
  TRANSIT_MODE_COLORS,
  vehicleNearView,
} from './policy.js';
import {
  fleetModelSet,
  loadFleetModelSet,
  transitModelSpec,
} from '../../data/fleetModels.js';
import { createFleetModelLayer } from '../../data/fleetModelInstances.js';
import { groundVehiclePartState } from '../../data/modelPartDrivers.js';

/** Layers built so far, so each one's draw sets have ids of their own. */
let instances = 0;

/** Radius, metres, of the sphere a vehicle is culled by. */
const CULL_RADIUS_M = 5;

/**
 * Markers and the per-frame glide.
 *
 * Each vehicle's marker is a plain record (`entry.marker`: its position,
 * whether it shows, its image, size, colour and screen rotation) drawn as
 * an icon in one of two draw sets: the still one, or the moving one while
 * it glides or turns, so a fleet at rest is not rewritten with the few
 * that move. Changed markers are pushed to their sets once per frame (and
 * once per visibility sweep), each with the one item object it keeps:
 * a frame pass over a moving fleet allocates nothing per vehicle.
 * @param {object} context
 * @returns {object}
 */
export function createRendering({ state, services, parts }) {
  const {
    governorRequestRender,
    holdContinuousRender,
    releaseContinuousRender,
  } = services.render;
  // The application's rendered-mesh sampler. Optional so a layer built on a
  // bare floor stub still runs; the application always supplies it.
  const sampleMeshFloorCells = services.mesh?.sampleMeshFloorCells || null;
  const instance = (instances += 1);

  // Markers changed since they were last pushed to their sets, in the order
  // first changed: a list kept between pushes (a set emptied and filled
  // again every frame allocates its table again), each entry holding its
  // place in it (`markerDirtyAt`; -1, or none, when not listed).
  const dirtyList = [];
  let dirtyCount = 0;
  const dirty = {
    add(entry) {
      if (entry.markerDirtyAt >= 0) return;
      entry.markerDirtyAt = dirtyCount;
      dirtyList[dirtyCount++] = entry;
    },
    delete(entry) {
      entry.markerDirtyAt = -1;
    },
    clear() {
      for (let i = 0; i < dirtyCount; i++) {
        const entry = dirtyList[i];
        if (entry.markerDirtyAt === i) entry.markerDirtyAt = -1;
        dirtyList[i] = undefined;
      }
      dirtyCount = 0;
    },
  };
  // Kept between pushes, at the length the last push gave them, so a push
  // of as many markers as the last allocates no lists.
  const stillUpserts = [];
  const movingUpserts = [];
  const stillRemovals = [];
  const movingRemovals = [];

  /**
   * The two icon sets, still and moving, hidden, in the scene now (with no
   * items), each at its place in the shared sprite order. A viewer of the
   * layer's own draws through `./render/cesium/unbound`, which its owner loads.
   * @param {object} viewer
   */
  function createMarkers(viewer) {
    destroyMarkers(viewer);
    const draw = drawOf(viewer);
    const drawOrder = (layerId) =>
      services.sprites?.spriteDrawOrder?.(layerId) ?? 0;
    state._stillIcons = draw.icons({
      id: `transit:${instance}:still`,
      blend: 'translucent',
      show: false,
      drawOrder: drawOrder('transit'),
    });
    state._movingIcons = draw.icons({
      id: `transit:${instance}:moving`,
      blend: 'translucent',
      show: false,
      drawOrder: drawOrder('transit-motion'),
    });
    // Emptied, they are drawn now: in the scene at once.
    state._stillIcons.set([]);
    state._movingIcons.set([]);
    state._markersShown = false;
  }

  /** Show both sets. */
  function showMarkers() {
    if (!state._stillIcons) return;
    state._stillIcons.show = true;
    state._movingIcons.show = true;
    state._markersShown = true;
  }

  /** Drop every marker and hide both sets. */
  function clearMarkers() {
    dirty.clear();
    stillRemovals.length = 0;
    movingRemovals.length = 0;
    state._stillIcons?.clear();
    state._movingIcons?.clear();
    if (state._movingIcons) state._movingIcons.show = false;
    if (state._stillIcons) state._stillIcons.show = false;
    state._markersShown = false;
  }

  /**
   * Let both sets go.
   * @param {object|null|undefined} _viewer
   */
  function destroyMarkers(_viewer) {
    dirty.clear();
    stillRemovals.length = 0;
    movingRemovals.length = 0;
    if (state._stillIcons) {
      state._stillIcons.dispose();
      state._stillIcons = null;
    }
    if (state._movingIcons) {
      state._movingIcons.dispose();
      state._movingIcons = null;
    }
    state._markersShown = false;
  }

  /** The ids of both sets (for the frame probe and floor sampling). */
  function setIds() {
    return [state._stillIcons?.id, state._movingIcons?.id, modelSetId()].filter(
      Boolean,
    );
  }

  /** Whether `setId` is one of this layer's sets. */
  function ownsSet(setId) {
    return (
      typeof setId === 'string' &&
      (setId === state._stillIcons?.id ||
        setId === state._movingIcons?.id ||
        setId === modelSetId())
    );
  }

  /** Which of the sets a draw set id is: `'moving'`, `'still'` or null. */
  function setNameOf(setId) {
    if (setId && setId === state._movingIcons?.id) return 'moving';
    if (setId && setId === state._stillIcons?.id) return 'still';
    // A vehicle drawn as its model is picked as the vehicle.
    if (setId && setId === modelSetId()) return 'model';
    return null;
  }

  /** Whether a vehicle's marker is shown. */
  function markerShown(entry) {
    return entry.marker?.show === true;
  }

  /** Note that a marker changed, for the next push. */
  function markDirty(entry) {
    if (entry.marker) dirty.add(entry);
  }

  /** Show or hide a marker. */
  function setShown(entry, shown) {
    if (entry.marker.show === shown) return;
    entry.marker.show = shown;
    dirty.add(entry);
  }

  /**
   * The icon item a marker draws as: the one item object the vehicle
   * keeps, brought up to date. Its position is the marker's own, which the
   * frame pass moves in place; the renderer reads positions as they are
   * when pushed.
   */
  function itemOf(entry) {
    const marker = entry.marker;
    const item = (entry.iconItem ||= {
      id: entry.key,
      pos: marker.position,
      image: marker.image,
      size: [0, 0],
      color: marker.color,
      rotationMode: 'screen',
      rotation: 0,
      show: false,
      disableDepthTest: Infinity,
      meta: { layer: 'transit', key: entry.key },
    });
    item.pos = marker.position;
    item.image = marker.image;
    item.size[0] = marker.width;
    item.size[1] = marker.height;
    item.color = marker.color;
    item.rotation = marker.rotation;
    item.show = marker.show;
    return item;
  }

  /**
   * Push the markers changed since the last push to their sets: a marker
   * that changed set leaves the one it was in first.
   */
  function flushMarkers() {
    const still = state._stillIcons;
    const moving = state._movingIcons;
    if (!still || !moving) return;
    if (!dirtyCount && !stillRemovals.length && !movingRemovals.length) return;
    let stillCount = 0,
      movingCount = 0;
    for (let i = 0; i < dirtyCount; i++) {
      const entry = dirtyList[i];
      // Taken out of the list (or listed again later) since it was put here.
      if (entry.markerDirtyAt !== i || !entry.marker) continue;
      const target = entry.animated ? moving : still;
      if (entry.drawnIn && entry.drawnIn !== target)
        (entry.drawnIn === still ? stillRemovals : movingRemovals).push(
          entry.key,
        );
      entry.drawnIn = target;
      if (target === still) stillUpserts[stillCount++] = itemOf(entry);
      else movingUpserts[movingCount++] = itemOf(entry);
    }
    dirty.clear();
    // Emptied and filled again, a list allocates its storage again: each
    // is cut only to what this push has.
    if (stillUpserts.length !== stillCount) stillUpserts.length = stillCount;
    if (movingUpserts.length !== movingCount)
      movingUpserts.length = movingCount;
    if (stillRemovals.length) still.remove(stillRemovals);
    if (movingRemovals.length) moving.remove(movingRemovals);
    if (stillCount) still.upsert(stillUpserts);
    if (movingCount) moving.upsert(movingUpserts);
    stillRemovals.length = 0;
    movingRemovals.length = 0;
  }

  /**
   * Take a vehicle's marker out of the set it is drawn in: with the others
   * taken out in this task, in one removal (a sweep drops many at once).
   */
  let flushQueued = false;
  function removeMarker(entry) {
    dirty.delete(entry);
    const set = entry.drawnIn;
    entry.drawnIn = null;
    if (!set) return;
    if (set === state._stillIcons) stillRemovals.push(entry.key);
    else if (set === state._movingIcons) movingRemovals.push(entry.key);
    else return;
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flushMarkers();
    });
  }

  /**
   * Listen for the camera moving, at this layer's own threshold.
   *
   * The camera port measures `changed` per listener, so this layer's finer
   * trigger (it needs to notice it has entered a feed's coverage) is its own
   * and leaves every other listener's untouched.
   * @param {object} viewer
   * @param {() => void} onChanged
   */
  function watchCamera(viewer, onChanged) {
    unwatchCamera();
    state._cameraChangedOff =
      findCamera(viewer)?.on('changed', onChanged, {
        threshold: CAMERA_PERCENTAGE_CHANGED,
      }) ?? null;
    // A new listener measures from the view at the next tick, so a move made
    // before that tick never reaches it: look again once that tick is past.
    if (!state._cameraChangedOff) return;
    let ticks = 0;
    state._cameraFirstTickOff =
      findFrame(viewer)?.on('preUpdate', () => {
        if (++ticks < 2) return;
        state._cameraFirstTickOff?.();
        state._cameraFirstTickOff = null;
        onChanged();
      }) ?? null;
  }

  /** Stop listening for the camera moving. */
  function unwatchCamera() {
    state._cameraChangedOff?.();
    state._cameraChangedOff = null;
    state._cameraFirstTickOff?.();
    state._cameraFirstTickOff = null;
  }

  /** Run the per-frame glide before each render, once. */
  function startFrames(viewer) {
    if (!state._preRenderRemove)
      state._preRenderRemove =
        findFrame(viewer)?.on('preRender', onPreRender) ?? null;
  }

  /** Stop the per-frame glide. */
  function stopFrames() {
    if (state._preRenderRemove) {
      state._preRenderRemove();
      state._preRenderRemove = null;
    }
  }

  // The camera's pose and the globe's surface version, read once in a task:
  // a sweep, a frame or a poll asks for them per vehicle, and reading them
  // walks the camera's frames and the scene's primitives. Forgotten when the
  // task ends, and at the start of every frame and visibility sweep.
  let viewMemo = null;
  let viewMemoQueued = false;
  function forgetView() {
    viewMemo = null;
  }
  function viewOf() {
    if (viewMemo) return viewMemo;
    viewMemo = { pose: undefined, surface: undefined };
    if (!viewMemoQueued) {
      viewMemoQueued = true;
      queueMicrotask(() => {
        viewMemoQueued = false;
        viewMemo = null;
      });
    }
    return viewMemo;
  }

  /** The camera port's pose, or null without a camera. */
  function cameraPose() {
    const view = viewOf();
    if (view.pose === undefined)
      view.pose = findCamera(state._viewer)?.pose() ?? null;
    return view.pose;
  }

  /**
   * The camera's height above the ellipsoid, or Infinity when it has none.
   * @returns {number}
   */
  function cameraHeightM() {
    const height = cameraPose()?.height;
    return Number.isFinite(height) ? height : Infinity;
  }

  /** The camera's subpoint in degrees, for the sampler's proximity gate. */
  function viewerSubpoint() {
    const pose = cameraPose();
    if (!pose) return { viewerLat: undefined, viewerLon: undefined };
    return { viewerLat: pose.lat, viewerLon: pose.lon };
  }

  // Whether the globe's terrain is the bare ellipsoid, as the height service
  // last said for the surface `surfaceVersion` names; asked again whenever
  // that changes, keeping the last answer until the new one comes. A terrain
  // height that is only the ellipsoid's is one the service counts as a miss
  // when asked to, so the ellipsoid is the point answered plainly and missed
  // that way.
  let flatVersion = null;
  let flatTerrain = false;
  function askFlat(globe) {
    const view = viewOf();
    if (view.surface === undefined)
      view.surface = globe.surfaceVersion?.() ?? 0;
    const version = view.surface;
    if (version === flatVersion) return;
    flatVersion = version;
    const pose = cameraPose();
    const point = {
      lon: Number.isFinite(pose?.lon) ? pose.lon : 0,
      lat: Number.isFinite(pose?.lat) ? pose.lat : 0,
    };
    const heights = heightsOf(state._viewer);
    Promise.all([
      heights.batch([point], { against: 'terrain' }),
      heights.batch([point], { against: 'terrain', ellipsoidMisses: true }),
    ]).then(
      ([[answered], [terrain]]) => {
        if (flatVersion !== version) return;
        const flat = answered !== null && terrain === null;
        if (flat === flatTerrain) return;
        flatTerrain = flat;
        // Floors read under the last answer are read again under this one,
        // in a fresh cycle (which replaces the one pending).
        if (state._enabled) parts.height.anchorFloors?.();
      },
      () => {
        // Asked again at the next read.
        if (flatVersion === version) flatVersion = null;
      },
    );
  }

  /**
   * What the globe draws under the fleet: `'none'` when it is hidden (the
   * photoreal stack), `'flat'` on the ellipsoid, `'terrain'` otherwise.
   * @returns {'none'|'flat'|'terrain'}
   */
  function globeSurface() {
    const globe = findGlobe(state._viewer);
    if (globe?.isGlobeVisible?.() !== true) return 'none';
    askFlat(globe);
    return flatTerrain ? 'flat' : 'terrain';
  }

  /**
   * Sample the rendered mesh under floor cells, seeing through this layer's
   * own sets.
   * @param {object[]} cells
   */
  function sampleMeshFloors(cells) {
    if (!sampleMeshFloorCells) return;
    const sets = setIds();
    for (let i = 0; i < cells.length; i += 8)
      sampleMeshFloorCells(state._viewer, cells.slice(i, i + 8), {
        sets,
        ...viewerSubpoint(),
      });
  }

  /**
   * ECEF position for a lat/lon at a height. Called on POLL, not per frame:
   * the conversion runs trigonometry, and doing that for every vehicle on
   * every frame was most of what made this layer heavy.
   */
  function cartesianFor(lat, lon, heightM, out = { x: 0, y: 0, z: 0 }) {
    // `heightM` already carries the shared floor's own lift, so nothing is
    // added here: two lifts stacked is a vehicle hovering.
    return fromDegreesInto(lon, lat, heightM || 0, out);
  }

  /** Heights are aligned to work with Google 3D tiles. Rebuild both ends. */
  function refreshEndpoints(entry) {
    if (!entry.sample || entry.sample.fromSeq < 0) return;
    entry.from = entry.segment.from;
    entry.to = entry.segment.to;
    entry.fromCart = cartesianFor(
      entry.from.lat,
      entry.from.lon,
      entry.from.h,
      entry.fromCart || { x: 0, y: 0, z: 0 },
    );
    entry.toCart = cartesianFor(
      entry.to.lat,
      entry.to.lon,
      entry.to.h,
      entry.toCart || { x: 0, y: 0, z: 0 },
    );
    entry.endpointRevision = entry.sample.revision;
    entry.endpointFromSeq = entry.sample.fromSeq;
    entry.endpointToSeq = entry.sample.toSeq;
  }
  function placeSample(entry, nearGround = parts.height.nearGround()) {
    if (
      entry.endpointRevision !== entry.sample.revision ||
      entry.endpointFromSeq !== entry.sample.fromSeq ||
      entry.endpointToSeq !== entry.sample.toSeq
    )
      refreshEndpoints(entry);
    const known = parts.trails.samplePosition(
      entry,
      entry.sample,
      state._scratchCartesian,
      nearGround,
    );
    entry.surfaceReady = !!known;
    entry.heightPending = !known;
    // A vehicle a first-person view rides keeps moving, unseen.
    setShown(
      entry,
      !!known &&
        vehicleInView(entry) &&
        !entry.modelOwnsVisual &&
        entry.key !== state._cockpitSubjectKey,
    );
    if (known) {
      const p = entry.marker.position;
      const s = state._scratchCartesian;
      if (p.x !== s.x || p.y !== s.y || p.z !== s.z) {
        p.x = s.x;
        p.y = s.y;
        p.z = s.z;
        dirty.add(entry);
      }
      entry.hasRendered = true;
    }
  }
  function sampleIdle(entry) {
    if (!state._moving.has(entry)) {
      updatePlayback(entry, state.now(), performance.now());
      placeSample(entry);
    }
  }

  function cancelWake(entry) {
    if (entry.wakeTimer != null) clearTimeout(entry.wakeTimer);
    entry.wakeTimer = null;
  }
  /** Draw a marker in the moving set, or the still one. */
  function migrateMarker(entry, animated) {
    if (!entry.marker || entry.animated === animated) return;
    entry.animated = animated;
    entry.markerRevision = (entry.markerRevision || 0) + 1;
    dirty.add(entry);
  }
  function schedulePlayback(entry) {
    cancelWake(entry);
    if (!entry.marker || !vehicleInView(entry)) {
      state._moving.delete(entry);
      migrateMarker(entry, false);
      return;
    }
    const sample = entry.sample;
    if (!sample || entry.heightPending || entry.surfaceReady === false) {
      state._moving.delete(entry);
      migrateMarker(entry, false);
      return;
    }
    const positional = playbackMoving(entry);
    const turning =
      Number.isFinite(sample.segmentCourseDeg) &&
      Number.isFinite(entry.courseDeg) &&
      Math.abs(
        ((sample.segmentCourseDeg - entry.courseDeg + 540) % 360) - 180,
      ) > 0.01;
    if (positional || turning) {
      state._moving.add(entry);
      migrateMarker(entry, true);
    } else {
      state._moving.delete(entry);
      migrateMarker(entry, false);
      // A vehicle a host-supplied placement holds still is asked again every
      // PLACED_WAKE_MS: it moves on once the placement does.
      const monoNow = performance.now();
      const placedWake = entry.placed === true;
      const boundary = sample.nextWakeMonoMs;
      const wakeMonoMs = placedWake
        ? Math.min(
            Number.isFinite(boundary) ? boundary : Infinity,
            monoNow + PLACED_WAKE_MS,
          )
        : boundary;
      if (Number.isFinite(wakeMonoMs)) {
        const atBoundary = !placedWake || boundary <= wakeMonoMs;
        entry.wakeTimer = setTimeout(
          () => {
            entry.wakeTimer = null;
            if (!state._enabled || !state._vehicles.has(entry.key)) return;
            updatePlayback(entry, state.now(), performance.now());
            placeSample(entry);
            schedulePlayback(entry);
            flushMarkers();
            syncRenderHold();
            if (atBoundary || state._moving.has(entry))
              governorRequestRender('transit-motion-boundary');
          },
          Math.max(1, wakeMonoMs - monoNow),
        );
      }
    }
  }

  /**
   * Whether either end of the segment being drawn is near the view — the
   * test visibility, animation and rotation all share.
   * @param {object} entry
   * @returns {boolean}
   */
  function vehicleInView(entry) {
    return state._visible.has(entry) || entry.key === state._cockpitSubjectKey;
  }

  /** A preset tuple as a colour (0..1 channels), cached per profile+mode. */
  const _presetColors = new Map();
  function presetColor(style, mode) {
    const rgba = presetSpriteRgba(style, mode);
    if (!rgba) return null;
    const key = `${transitStyleProfile(style)}:${mode}`;
    let color = _presetColors.get(key);
    if (!color) {
      color = Object.freeze([
        rgba[0] / 255,
        rgba[1] / 255,
        rgba[2] / 255,
        rgba[3],
      ]);
      _presetColors.set(key, color);
    }
    return color;
  }

  /**
   * The ONE place a sprite's look is decided: creation, a mode change, select,
   * deselect and a preset change all come here, so no path can undo another.
   * Under a mono preset (NVG, FLIR, noir) the sprite is white-hot with a dark
   * halo sized in screen pixels; under CRT a saturated mode colour with a
   * thinner halo; otherwise the shipped mode colour and hairline. Selection
   * keeps the glyph's size and mode colour, widening only its halo and
   * drawing from a crisper raster; sensors use opaque white.
   * @param {object} entry
   */
  function applySpriteStyle(entry) {
    const marker = entry.marker;
    if (!marker) return;
    const style = state._stylePreset;
    const selected = state._selectedKey === entry.key;
    const basePx = MARKER_PIXEL_SIZE;
    const halo = presetSpriteOutlinePx(style, selected);
    const displayPx = basePx * presetSpriteScale(style, selected);
    const frame = haloFrame(halo, displayPx);
    const px = displayPx * frame.ratio;
    // A glyph with a front only when there is a course to point it along:
    // without one the billboard sits at rotation 0 and a nose would say north.
    const heading = Number.isFinite(entry.courseDeg);
    entry.iconHeading = heading;
    marker.image = transitIcon(
      entry.mode,
      selected ? SELECTED_ICON_PX : undefined,
      {
        style,
        heading,
      },
    );
    marker.width = px;
    marker.height = px;
    if (entry.detectContact) {
      entry.detectContact.bracketHalfWidth = Math.ceil(px / 2) + 2;
      entry.detectContact.bracketHalfHeight = Math.ceil(px / 2) + 2;
    }
    marker.color =
      presetColor(style, entry.mode) ||
      TRANSIT_MODE_COLORS[entry.mode] ||
      TRANSIT_MODE_COLORS.unknown;
    dirty.add(entry);
  }

  /** Swap between the pointed and the neutral glyph when a course appears or is lost. */
  function syncHeadingIcon(entry) {
    if (entry.marker && entry.iconHeading !== Number.isFinite(entry.courseDeg))
      applySpriteStyle(entry);
  }

  function addMarker(key, entry) {
    const at = entry.toCart;
    const marker = {
      // Moved every frame in place: a `Vec3`, so a move allocates nothing.
      position: new Vec3(at?.x ?? 0, at?.y ?? 0, at?.z ?? 0),
      show: false,
      image: transitIcon(entry.mode),
      width: MARKER_PIXEL_SIZE,
      height: MARKER_PIXEL_SIZE,
      color: TRANSIT_MODE_COLORS[entry.mode],
      rotation: 0,
    };
    entry.marker = marker;
    entry.animated = false;
    entry.drawnIn = null;
    applySpriteStyle(entry);
    return marker;
  }

  function paintMode(entry, mode) {
    entry.mode = mode;
    if (entry.key === state._selectedKey) {
      parts.trails.style();
      parts.selection.refreshSelectedCard(true);
    }
    state._detectRevision += 1;
    applySpriteStyle(entry);
  }

  /**
   * Adopt a post-FX style. One pass over the fleet, on the event, never per
   * frame; a style already applied is a no-op.
   * @param {string|null|undefined} styleName
   */
  function setStylePreset(styleName) {
    const next = styleName || 'normal';
    if (next === state._stylePreset) return;
    state._stylePreset = next;
    for (const entry of state._vehicles.values()) applySpriteStyle(entry);
    flushMarkers();
    parts.trails.style();
    governorRequestRender('transit-style');
  }

  /**
   * The screen rotation that points a marker along `course`, projected
   * exactly through the query port (see `perspectiveCourseRotation`).
   */
  function courseRotation(query, pose, position, course, previous) {
    return perspectiveCourseRotation(
      query.project,
      pose,
      position,
      course,
      previous,
    );
  }

  /**
   * Point every glyph along its reported course.
   *
   * Icons are camera-facing quads, so a course has to be projected into
   * screen space — which depends on where the camera is, not only on the
   * vehicle. Doing that for the whole fleet on every frame is exactly the kind
   * of cost that made this layer heavy, and it buys nothing: a bus icon whose
   * rotation is a fifth of a second stale is indistinguishable. So the pass is
   * throttled, and runs only when the camera has actually moved or a poll
   * changed somebody's heading.
   */
  function refreshRotations(now) {
    if (now - state._rotationAt < ROTATION_REFRESH_MS) return;
    const pose = cameraPose();
    const query = findQuery(state._viewer);
    if (!pose?.position || !query) return;
    state._rotationAt = now;
    const signature = poseSignature(pose);
    const cameraChanged =
      state._rotationPose !== signature ||
      state._rotationRevision !== state._cameraRevision;
    if (!cameraChanged && !state._rotationDirty && state._moving.size === 0)
      return;
    state._rotationPose = signature;
    state._rotationRevision = state._cameraRevision;
    state._rotationDirty = false;
    const monoNow = performance.now();
    for (const entry of state._visible) {
      // Idle contacts still need a course when their first usable bearing arrives.
      if (!state._moving.has(entry)) applyDisplayCourse(entry, monoNow);
      syncHeadingIcon(entry);
      if (entry.key === state._selectedKey) continue;
      const marker = entry.marker;
      const course = entry.courseDeg;
      if (!Number.isFinite(course)) {
        if (marker.rotation !== 0) dirty.add(entry);
        marker.rotation = 0;
        entry.rotationCourse = null;
        continue;
      }
      const position = marker.position;
      if (
        !cameraChanged &&
        entry.rotationCourse === course &&
        Math.abs(position.x - entry.rotationX) +
          Math.abs(position.y - entry.rotationY) +
          Math.abs(position.z - entry.rotationZ) <
          10
      )
        continue;
      entry.rotationCourse = course;
      entry.rotationX = position.x;
      entry.rotationY = position.y;
      entry.rotationZ = position.z;
      // Exact projection, perspective division included. The shared
      // camera-basis helper aircraft use is orthographic — fine at altitude,
      // and wrong by twenty-odd degrees for a street-level contact away from
      // the centre of an obliquely pitched view, which is most of them.
      const rotation = courseRotation(
        query,
        pose,
        position,
        course,
        marker.rotation,
      );
      if (rotation !== marker.rotation) {
        marker.rotation = rotation;
        dirty.add(entry);
      }
    }
  }

  /** Publish final motion wording when the selected contact settles. */
  function settleSelectedCard(entry) {
    if (state._selectedKey && state._selectedKey === entry.key) {
      parts.selection.refreshSelectedCard(true);
    }
  }

  /** Hold only for visible position or orientation animation. */
  function syncRenderHold() {
    // Held for motion only. Ground resolution runs on its own timer off the
    // render path, so a fleet waiting for floors is not a fleet worth burning
    // frames on — it is not moving.
    const working = state._enabled && state._moving.size > 0;
    if (working && !state._renderHeld) {
      holdContinuousRender('transit');
      state._renderHeld = true;
    } else if (!working && state._renderHeld) {
      releaseContinuousRender('transit');
      state._renderHeld = false;
      governorRequestRender('transit-settled');
    }
  }

  function onPreRender() {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    )
      return;
    if (!state._enabled) return;
    forgetView();
    const now = state.now();
    if (state._vehicles.size === 0) {
      state._moving.clear();
      updateModels();
      syncRenderHold();
      return;
    }

    const monoNow = performance.now();
    const nearGround = parts.height.nearGround();
    let dirtyCount = 0;
    for (const entry of state._heightDirty) {
      if (dirtyCount++ >= 64) break;
      state._heightDirty.delete(entry);
      if (!entry.marker) continue;
      updatePlayback(entry, now, monoNow);
      placeSample(entry, nearGround);
      schedulePlayback(entry);
    }
    for (const entry of state._moving) {
      if (!entry.marker || !vehicleInView(entry)) {
        state._moving.delete(entry);
        continue;
      }
      updatePlayback(entry, now, monoNow);
      placeSample(entry, nearGround);
      if (applyDisplayCourse(entry, monoNow)) state._rotationDirty = true;
      if (
        !entry.surfaceReady ||
        entry.sample.phase !== 'playing' ||
        entry.sample.segmentSpeedMps === 0 ||
        (entry.placed === true && entry.placedMoving !== true)
      )
        schedulePlayback(entry);
      if (!state._moving.has(entry)) settleSelectedCard(entry);
    }

    parts.trails.update();
    refreshRotations(Date.now());
    const selected = state._vehicles.get(state._selectedKey);
    if (selected && state._visible.has(selected)) {
      syncHeadingIcon(selected);
      const marker = selected.marker;
      const pose = Number.isFinite(selected.courseDeg) ? cameraPose() : null;
      const query = pose?.position ? findQuery(state._viewer) : null;
      const rotation = query
        ? courseRotation(
            query,
            pose,
            marker.position,
            selected.courseDeg,
            marker.rotation,
          )
        : Number.isFinite(selected.courseDeg)
          ? marker.rotation
          : 0;
      if (rotation !== marker.rotation) {
        marker.rotation = rotation;
        dirty.add(selected);
      }
    }
    flushMarkers();
    if (state._heightDirty.size) governorRequestRender('transit-height-batch');
    updateModels();
    syncRenderHold();
  }

  // Under the DISPLAY rail's 3D toggle, vehicles in view near the camera are
  // drawn as the project's procedural fleet models, chosen by mode, painted
  // in their mode colour where the model marks it, on the aircraft layers'
  // icon-to-model rules (services.fleet). The fleet set loads once, up front,
  // when the layer starts.
  let fleetModels = null;
  /** Items drawn last frame, and the map the next frame's are gathered into. */
  let modelItems = new Map();
  let spareItems = new Map();
  /** The lift icons are drawn with above the floor; a model stands on the floor. */
  const groundLiftM = services.ground?.GROUND_FLOOR_LIFT_M || 0;

  /** Load the fleet set and create the layer's models (on enable). */
  function startModels() {
    const fleet = services.fleet;
    if (!fleet?.policy || !state._viewer) return;
    loadFleetModelSet({ resolveAsset: fleet.resolveAsset }).catch(() => {
      /* models stay off; vehicles keep their icons */
    });
    fleetModels ||= createFleetModelLayer({
      viewer: state._viewer,
      display: fleet.display,
      policy: fleet.policy,
      resolveAsset: fleet.resolveAsset,
      partState: vehiclePartState,
    });
  }

  /**
   * Wheels rolling at the speed it is drawn moving at (else its reported
   * one), doors open while it stands at a stop.
   */
  function vehiclePartState(item, table) {
    const entry = item.entry;
    const drawn = entry?.sample?.segmentSpeedMps;
    const reported = entry?.record?.speedMps;
    return groundVehiclePartState(table, {
      speedMps: Number.isFinite(drawn)
        ? drawn
        : Number.isFinite(reported)
          ? reported
          : null,
      atStop: entry?.record?.status === 'STOPPED_AT',
    });
  }

  /** Hand an entry's visual back to its icon, unless a view rides it. */
  function handBack(entry) {
    if (!entry.modelOwnsVisual) return;
    entry.modelOwnsVisual = false;
    if (entry.marker)
      setShown(
        entry,
        vehicleInView(entry) &&
          !entry.heightPending &&
          entry.surfaceReady !== false &&
          entry.key !== state._cockpitSubjectKey,
      );
  }

  function updateModels() {
    if (!fleetModels) return;
    if (!fleetModels.active() || state._vehicles.size === 0) {
      if (modelItems.size) {
        for (const item of modelItems.values()) handBack(item.entry);
        modelItems.clear();
        fleetModels.frame(modelItems, performance.now());
      }
      return;
    }
    const set = fleetModelSet();
    const next = spareItems;
    next.clear();
    for (const entry of state._visible) {
      // A vehicle of no known mode keeps its icon: no model says what it is.
      if (!entry.marker || !entry.hasRendered || entry.mode === 'unknown')
        continue;
      let item = modelItems.get(entry.key);
      if (!item || item.entry !== entry) {
        item = {
          entry,
          pickId: entry.key,
          modelOwnsVisual: false,
          groundLiftM,
        };
      }
      if (item.mode !== entry.mode || item.routeType !== entry.routeType) {
        item.mode = entry.mode;
        item.routeType = entry.routeType;
        // The route type picks the finer model (a coach, a high-speed set);
        // the mode is the fallback for a type the model table lacks.
        item.spec = transitModelSpec(set, {
          routeType: entry.routeType,
          mode: entry.mode,
        });
        item.tint =
          TRANSIT_MODE_COLORS[entry.mode] || TRANSIT_MODE_COLORS.unknown;
      }
      item.position = entry.marker.position;
      item.headingDeg = Number.isFinite(entry.courseDeg) ? entry.courseDeg : 0;
      // A vehicle a first-person view rides draws no model: the camera is
      // inside it (cockpitSubject.js).
      item.show =
        !entry.heightPending &&
        entry.surfaceReady !== false &&
        entry.key !== state._cockpitSubjectKey;
      next.set(entry.key, item);
    }
    for (const [key, item] of modelItems)
      if (next.get(key) !== item) handBack(item.entry);
    spareItems = modelItems;
    modelItems = next;
    fleetModels.frame(modelItems, performance.now());
    for (const item of modelItems.values()) {
      const entry = item.entry;
      if (item.modelOwnsVisual) {
        entry.modelOwnsVisual = true;
        setShown(entry, false);
      } else handBack(entry);
    }
    if (fleetModels.settling) governorRequestRender('transit-models');
  }

  /** The fleet models' set id, or null before the layer draws models. */
  function modelSetId() {
    return fleetModels?.setId ?? null;
  }

  /** Drop every model (layer disabled); `destroy` also lets their set go. */
  function stopModels(destroy = false) {
    for (const item of modelItems.values()) item.entry.modelOwnsVisual = false;
    modelItems.clear();
    spareItems.clear();
    if (destroy) {
      fleetModels?.destroy();
      fleetModels = null;
    } else fleetModels?.clear();
  }

  const candidatePosition = { x: 0, y: 0, z: 0 };
  /** Visibility work runs off the frame path, coalesced at four sweeps/second. */
  function requestVisibility() {
    state._visibilityDirty = true;
    if (!state._enabled || state._visibilityTimer !== null) return;
    state._visibilityTimer = setTimeout(
      () => {
        state._visibilityTimer = null;
        refreshVisibility();
      },
      Math.max(0, VISIBILITY_REFRESH_MS - (Date.now() - state._visibilityAt)),
    );
  }

  function refreshVisibility() {
    if (!state._enabled) return 0;
    const now = Date.now();
    if (now - state._visibilityAt < VISIBILITY_REFRESH_MS) {
      requestVisibility();
      return state._shownCount;
    }
    state._visibilityAt = now;
    state._visibilityDirty = false;
    forgetView();
    const pose = cameraPose();
    if (!pose) return 0;
    const query = findQuery(state._viewer);
    const planes = viewPlanes(pose);
    let changed = false;
    for (const entry of state._vehicles.values()) {
      if (!entry.marker) continue;
      // Refresh hidden clocks before testing admission, even if no frame has
      // ever sampled them. Do not write the marker until it is admitted.
      const noSample = !entry.sample || !Number.isFinite(entry.sample.lat);
      if (entry.track?.count && (!state._visible.has(entry) || noSample)) {
        entry.sample ||= {};
        updatePlayback(entry, state.now(), performance.now());
      }
      const center =
        state._visible.has(entry) || !entry.sample
          ? entry.marker.position
          : cartesianFor(
              entry.sample.lat,
              entry.sample.lon,
              entry.heightM,
              candidatePosition,
            );
      // A settled geographic rectangle can lag setView or miss an oblique
      // view. The current frustum is authoritative; the horizon still rejects
      // the far side when the rectangle is missing or stale.
      const bounds = vehicleNearView(state._viewBounds, entry);
      const horizon = !(query?.isOccluded(center) ?? false);
      let inFrustum = true;
      if (planes) {
        for (let i = 0; i < planes.length; i++) {
          const { normal: n, w } = planes[i];
          if (
            n.x * center.x + n.y * center.y + n.z * center.z + w <
            -CULL_RADIUS_M
          ) {
            inFrustum = false;
            break;
          }
        }
      }
      // A held vehicle (cockpitSubject.js) is the camera's own: it stays in
      // play wherever the view looks.
      const held = entry.key === state._cockpitSubjectKey;
      const visible = held || ((planes || bounds) && horizon && inFrustum);
      const visibility = (entry.visibility ||= {});
      visibility.bounds = bounds;
      visibility.boundsApplied = !planes;
      visibility.occluder = horizon;
      visibility.frustum = inFrustum;
      visibility.noSample = noSample;
      const wasShown = entry.marker.show;
      const wasVisible = state._visible.has(entry);
      // Just let go of a hold (cockpitSubject.js): it played on, so keep
      // its clock.
      const playedOn = entry.releasedFromHold === true;
      entry.releasedFromHold = false;
      if (visible) state._visible.add(entry);
      else state._visible.delete(entry);
      // Turned afresh once back in view: the camera may have moved while it
      // was out, after the pass that would have turned it.
      if (visible && !wasVisible) entry.rotationCourse = undefined;
      if (visible && entry.track?.count) {
        if (!wasVisible && !playedOn && !entry.qaFixture)
          syncPlayback(entry, now);
        // Re-entry can advance into an unprepared corridor; loaded tiles can
        // also resolve a cold path without a poll or a render-loop wakeup.
        if (!wasVisible || entry.surfaceReady === false || entry.heightPending)
          parts.trails.prepareEntry(entry);
        // Surface completion must recover while requestRenderMode is idle.
        // Otherwise surfaceReady=false prevents the very frame that clears it.
        if (!state._moving.has(entry)) {
          updatePlayback(entry, now, performance.now());
          placeSample(entry);
        }
      }
      setShown(
        entry,
        Boolean(
          !held &&
          visible &&
          !entry.heightPending &&
          entry.surfaceReady !== false &&
          !entry.modelOwnsVisual,
        ),
      );
      visibility.heightPending = !!entry.heightPending;
      visibility.surfaceReady = entry.surfaceReady ?? null;
      schedulePlayback(entry);
      changed ||= visible !== wasVisible || wasShown !== entry.marker.show;
    }
    flushMarkers();
    state._shownCount = state._visible.size;
    if (changed) {
      state._detectRevision++;
      // A vehicle that came into view or was shown is turned on the next
      // rotation pass, though neither the camera nor a poll changed.
      state._rotationDirty = true;
    }
    syncRenderHold();
    governorRequestRender('transit-visibility');
    return state._shownCount;
  }
  function resumePlayback() {
    if (!state._enabled) return;
    const now = state.now(),
      mono = performance.now();
    const entries = new Set(state._visible);
    const selected = state._vehicles.get(state._selectedKey);
    if (selected) entries.add(selected);
    for (const entry of entries) {
      if (!entry.track?.count) continue;
      syncPlayback(entry, now, mono);
      parts.trails.prepareEntry(entry);
      placeSample(entry);
      schedulePlayback(entry);
    }
    flushMarkers();
    parts.trails.update();
    parts.selection.refreshSelectedCard(true);
    state._detectRevision++;
    syncRenderHold();
    governorRequestRender('transit-re-entry');
  }
  // Text and membership refreshes are bounded timer work, never paint work.
  function maintainPresentation() {
    if (!state._enabled) return;
    if (state._moving.size) requestVisibility();
    parts.queries.refreshDetectCache();
    parts.selection.refreshSelectedCard(false);
  }

  /** Grow the selected glyph (or shrink it back) through the one styling path. */
  function paintSelected(entry, selected) {
    void selected; // decided from state._selectedKey, which the caller has set
    applySpriteStyle(entry);
    flushMarkers();
  }

  return {
    createMarkers,
    showMarkers,
    clearMarkers,
    destroyMarkers,
    setIds,
    ownsSet,
    setNameOf,
    markerShown,
    markDirty,
    flushMarkers,
    removeMarker,
    watchCamera,
    unwatchCamera,
    startFrames,
    stopFrames,
    cameraHeightM,
    globeSurface,
    sampleMeshFloors,
    resumePlayback,
    maintainPresentation,
    requestVisibility,
    sampleIdle,
    cancelWake,
    schedulePlayback,
    placeSample,
    cartesianFor,
    refreshEndpoints,
    refreshVisibility,
    vehicleInView,
    addMarker,
    paintMode,
    paintSelected,
    applySpriteStyle,
    setStylePreset,
    onPreRender,
    syncRenderHold,
    startModels,
    stopModels,
  };
}
