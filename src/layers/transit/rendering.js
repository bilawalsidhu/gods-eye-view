import * as Cesium from 'cesium';
// The Cesium camera factory: given a viewer of a caller's own, with no
// renderer bound, the layer's camera reads find a camera port.
import '../../render/cesium/camera.js';
import { webglContext } from '../../render/cesium/internals.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';
import {
  cameraPoseSignature,
  perspectiveProjectedRotation,
} from '../../render/cesium/iconOrientation.js';
import {
  updatePlayback,
  applyDisplayCourse,
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
  SELECTED_PIXEL_SIZE,
  TRANSIT_MODE_COLORS,
  vehicleNearView,
} from './policy.js';

export const MODE_CESIUM_COLORS = Object.fromEntries(
  Object.entries(TRANSIT_MODE_COLORS).map(([mode, css]) => [
    mode,
    Cesium.Color.fromCssColorString(css),
  ]),
);

/**
 * Billboards and the per-frame glide.
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

  /**
   * The two billboard collections, still and moving, added to the scene and
   * to the shared sprite order, hidden.
   * @param {object} viewer
   */
  function createMarkers(viewer) {
    state._markers = new Cesium.BillboardCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    viewer.scene.primitives.add(state._markers);
    services.sprites.registerSpriteCollection('transit', state._markers);
    state._animatedMarkers = new Cesium.BillboardCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    viewer.scene.primitives.add(state._animatedMarkers);
    services.sprites.registerSpriteCollection(
      'transit-motion',
      state._animatedMarkers,
    );
    state._animatedMarkers.show = false;
    state._markers.show = false;
  }

  /** Show both collections. */
  function showMarkers() {
    state._markers.show = true;
    state._animatedMarkers.show = true;
  }

  /** Drop every billboard and hide both collections. */
  function clearMarkers() {
    state._markers?.removeAll();
    state._animatedMarkers?.removeAll();
    if (state._animatedMarkers) state._animatedMarkers.show = false;
    if (state._markers) state._markers.show = false;
  }

  /**
   * Take both collections off the scene and out of the sprite order.
   * @param {object|null|undefined} viewer
   */
  function destroyMarkers(viewer) {
    if (state._markers) {
      services.sprites.unregisterSpriteCollection('transit', state._markers);
      viewer?.scene?.primitives?.remove(state._markers);
      state._markers = null;
    }
    if (state._animatedMarkers) {
      services.sprites.unregisterSpriteCollection(
        'transit-motion',
        state._animatedMarkers,
      );
      viewer?.scene?.primitives?.remove(state._animatedMarkers);
      state._animatedMarkers = null;
    }
  }

  /** Whether a vehicle's billboard is shown. */
  function markerShown(entry) {
    return entry.marker?.show === true;
  }

  /**
   * Listen for the camera moving, borrowing its change sensitivity through
   * the shared claim ledger.
   *
   * `camera.changed` fires on a percentage of the view moving, and this layer
   * needs a finer trigger than the default to notice it has entered a feed's
   * coverage. It is a single shared number, so the claim is registered by name
   * rather than written directly: comparing the VALUE on the way out could not
   * tell this layer's 0.05 from anybody else's, and handing back the coarse
   * default while Bikeshare was still relying on a fine one was exactly the
   * bug that produced.
   * @param {object} viewer
   * @param {() => void} onChanged
   */
  function watchCamera(viewer, onChanged) {
    viewer.camera.changed.addEventListener(onChanged);
    claimCameraSensitivity(
      viewer?.camera,
      'transit',
      CAMERA_PERCENTAGE_CHANGED,
    );
  }

  /** Stop listening and give the claim up; the camera keeps anyone else's. */
  function unwatchCamera(viewer, onChanged) {
    viewer.camera.changed.removeEventListener(onChanged);
    releaseCameraSensitivity(viewer?.camera, 'transit');
  }

  /** Run the per-frame glide before each render, once. */
  function startFrames(viewer) {
    if (!state._preRenderRemove)
      state._preRenderRemove =
        viewer.scene.preRender.addEventListener(onPreRender);
  }

  /** Stop the per-frame glide. */
  function stopFrames() {
    if (state._preRenderRemove) {
      state._preRenderRemove();
      state._preRenderRemove = null;
    }
  }

  /**
   * The camera's height above the ellipsoid, or Infinity when it has none.
   * @returns {number}
   */
  function cameraHeightM() {
    const carto = state._viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  /** The camera's subpoint in degrees, for the sampler's proximity gate. */
  function viewerSubpoint() {
    const carto = state._viewer?.camera?.positionCartographic;
    if (!carto) return { viewerLat: undefined, viewerLon: undefined };
    return {
      viewerLat: (carto.latitude * 180) / Math.PI,
      viewerLon: (carto.longitude * 180) / Math.PI,
    };
  }

  /**
   * What the globe draws under the fleet: `'none'` when it is hidden (the
   * photoreal stack), `'flat'` on the ellipsoid, `'terrain'` otherwise.
   * @returns {'none'|'flat'|'terrain'}
   */
  function globeSurface() {
    if (state._viewer?.scene?.globe?.show !== true) return 'none';
    return state._viewer?.terrainProvider instanceof
      Cesium.EllipsoidTerrainProvider
      ? 'flat'
      : 'terrain';
  }

  /**
   * Sample the rendered mesh under floor cells, seeing through these
   * vehicles' billboards.
   * @param {object[]} cells
   * @param {object[]} entries
   */
  function sampleMeshFloors(cells, entries) {
    if (!sampleMeshFloorCells) return;
    const markers = entries.map((entry) => entry.marker).filter(Boolean);
    for (let i = 0; i < cells.length; i += 8)
      sampleMeshFloorCells(state._viewer?.scene, cells.slice(i, i + 8), {
        excludeObjects: markers,
        ...viewerSubpoint(),
      });
  }

  /**
   * Cartesian position for a lat/lon at a height. Called on POLL, not per
   * frame: `fromDegrees` runs trigonometry, and doing that for every vehicle on
   * every frame was most of what made this layer heavy.
   */
  function cartesianFor(lat, lon, heightM, out) {
    // `heightM` already carries the shared floor's own lift, so nothing is
    // added here: two lifts stacked is a vehicle hovering.
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      heightM || 0,
      undefined,
      out,
    );
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
      entry.fromCart || new Cesium.Cartesian3(),
    );
    entry.toCart = cartesianFor(
      entry.to.lat,
      entry.to.lon,
      entry.to.h,
      entry.toCart || new Cesium.Cartesian3(),
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
    entry.marker.show = !!known && vehicleInView(entry);
    if (known) {
      entry.marker.position = state._scratchCartesian;
      entry.hasRendered = true;
    }
  }
  function sampleIdle(entry) {
    if (!state._moving.has(entry)) {
      updatePlayback(entry, Date.now(), performance.now());
      placeSample(entry);
    }
  }

  function cancelWake(entry) {
    if (entry.wakeTimer != null) clearTimeout(entry.wakeTimer);
    entry.wakeTimer = null;
  }
  function migrateMarker(entry, animated) {
    const collection = animated ? state._animatedMarkers : state._markers;
    if (!entry.marker || entry.markerCollection === collection) return;
    const old = entry.marker;
    const marker = collection.add({
      id: entry.key,
      position: old.position,
      image: old.image,
      width: old.width,
      height: old.height,
      color: old.color,
      scaleByDistance: old.scaleByDistance,
      rotation: old.rotation,
      alignedAxis: old.alignedAxis,
      show: old.show,
      disableDepthTestDistance: old.disableDepthTestDistance,
    });
    entry.markerCollection.remove(old);
    entry.marker = marker;
    entry.markerCollection = collection;
    entry.markerRevision = (entry.markerRevision || 0) + 1;
    // Cached contacts and card getters must follow the replacement billboard.
    if (entry.detectContact) entry.detectContact.position = marker.position;
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
    const positional = sample.phase === 'playing' && sample.segmentSpeedMps > 0;
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
      if (Number.isFinite(sample.nextWakeMonoMs)) {
        entry.wakeTimer = setTimeout(
          () => {
            entry.wakeTimer = null;
            if (!state._enabled || !state._vehicles.has(entry.key)) return;
            updatePlayback(entry, Date.now(), performance.now());
            placeSample(entry);
            schedulePlayback(entry);
            syncRenderHold();
            governorRequestRender('transit-motion-boundary');
          },
          Math.max(1, sample.nextWakeMonoMs - performance.now()),
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
    return state._visible.has(entry);
  }

  /** Cesium colour for a preset tuple, cached per profile+mode. */
  const _presetColors = new Map();
  function presetColor(style, mode) {
    const rgba = presetSpriteRgba(style, mode);
    if (!rgba) return null;
    const key = `${transitStyleProfile(style)}:${mode}`;
    let color = _presetColors.get(key);
    if (!color) {
      color = new Cesium.Color(
        rgba[0] / 255,
        rgba[1] / 255,
        rgba[2] / 255,
        rgba[3],
      );
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
   * grows the glyph and retains the mode colour; sensors use opaque white.
   * @param {object} entry
   */
  function applySpriteStyle(entry) {
    const marker = entry.marker;
    if (!marker) return;
    const style = state._stylePreset;
    const selected = state._selectedKey === entry.key;
    const basePx = selected ? SELECTED_PIXEL_SIZE : MARKER_PIXEL_SIZE;
    const halo = presetSpriteOutlinePx(style, selected);
    const displayPx = basePx * presetSpriteScale(style, selected);
    const frame = haloFrame(halo, displayPx);
    const px = displayPx * frame.ratio;
    marker.image = transitIcon(
      entry.mode,
      selected ? SELECTED_ICON_PX : undefined,
      {
        style,
      },
    );
    marker.width = px;
    marker.height = px;
    if (entry.detectContact) {
      entry.detectContact.bracketHalfWidth = Math.ceil(px / 2) + 2;
      entry.detectContact.bracketHalfHeight = Math.ceil(px / 2) + 2;
    }
    const preset = presetColor(style, entry.mode);
    if (preset) marker.color = preset;
    else
      marker.color =
        MODE_CESIUM_COLORS[entry.mode] || MODE_CESIUM_COLORS.unknown;
  }

  function addMarker(key, entry) {
    const marker = state._markers.add({
      id: key,
      position: entry.toCart,
      image: transitIcon(entry.mode),
      width: MARKER_PIXEL_SIZE,
      height: MARKER_PIXEL_SIZE,
      color: MODE_CESIUM_COLORS[entry.mode],
      rotation: 0,
      alignedAxis: Cesium.Cartesian3.ZERO,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    entry.marker = marker;
    entry.markerCollection = state._markers;
    marker.show = false;
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
    parts.trails.style();
    governorRequestRender('transit-style');
  }

  /**
   * Point every glyph along its reported course.
   *
   * Billboards are camera-facing quads, so a course has to be projected into
   * screen space — which depends on where the camera is, not only on the
   * vehicle. Doing that for the whole fleet on every frame is exactly the kind
   * of cost that made this layer heavy, and it buys nothing: a bus icon whose
   * rotation is a fifth of a second stale is indistinguishable. So the pass is
   * throttled, and runs only when the camera has actually moved or a poll
   * changed somebody's heading.
   */
  function refreshRotations(now) {
    const scene = state._viewer?.scene;
    if (!scene?.camera) return;
    if (now - state._rotationAt < ROTATION_REFRESH_MS) return;
    state._rotationAt = now;
    const pose = cameraPoseSignature(scene.camera);
    const cameraChanged =
      state._rotationPose !== pose ||
      state._rotationRevision !== state._cameraRevision;
    if (!cameraChanged && !state._rotationDirty && state._moving.size === 0)
      return;
    state._rotationPose = pose;
    state._rotationRevision = state._cameraRevision;
    state._rotationDirty = false;
    const monoNow = performance.now();
    for (const entry of state._visible) {
      // Idle contacts still need a course when their first usable bearing arrives.
      if (!state._moving.has(entry)) applyDisplayCourse(entry, monoNow);
      if (entry.key === state._selectedKey) continue;
      const course = entry.courseDeg;
      if (!Number.isFinite(course)) {
        entry.marker.rotation = 0;
        entry.rotationCourse = null;
        continue;
      }
      const position = entry.marker.position;
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
      entry.marker.rotation = perspectiveProjectedRotation(
        scene,
        entry.marker.position,
        course,
        entry.marker.rotation,
      );
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
    const now = Date.now();
    if (state._vehicles.size === 0) {
      state._moving.clear();
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
        entry.sample.segmentSpeedMps === 0
      )
        schedulePlayback(entry);
      if (!state._moving.has(entry)) settleSelectedCard(entry);
    }

    parts.trails.update();
    refreshRotations(now);
    const selected = state._vehicles.get(state._selectedKey);
    if (selected && state._visible.has(selected)) {
      selected.marker.rotation = Number.isFinite(selected.courseDeg)
        ? perspectiveProjectedRotation(
            state._viewer.scene,
            selected.marker.position,
            selected.courseDeg,
            selected.marker.rotation,
          )
        : 0;
    }
    if (state._heightDirty.size) governorRequestRender('transit-height-batch');
    syncRenderHold();
  }

  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  const sphere = new Cesium.BoundingSphere(undefined, 5);
  const cameraPosition = new Cesium.Cartesian3();
  const candidatePosition = new Cesium.Cartesian3();
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
    const viewer = state._viewer,
      camera = viewer?.camera;
    if (!camera) return 0;
    const position =
      camera.positionWC ||
      Cesium.Ellipsoid.WGS84.cartographicToCartesian(
        camera.positionCartographic,
        cameraPosition,
      );
    occluder.cameraPosition = position;
    const frustum = camera.frustum?.computeCullingVolume(
      position,
      camera.directionWC,
      camera.upWC,
    );
    const planes = frustum?.planes;
    let changed = false;
    for (const entry of state._vehicles.values()) {
      if (!entry.marker) continue;
      // Refresh hidden clocks before testing admission, even if no frame has
      // ever sampled them. Do not write the billboard until it is admitted.
      const noSample = !entry.sample || !Number.isFinite(entry.sample.lat);
      if (entry.track?.count && (!state._visible.has(entry) || noSample)) {
        entry.sample ||= {};
        updatePlayback(entry, now, performance.now());
      }
      sphere.center =
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
      const horizon = occluder.isPointVisible(sphere.center);
      let inFrustum = true;
      if (planes) {
        for (let i = 0; i < planes.length; i++) {
          const p = planes[i],
            c = sphere.center;
          if (p.x * c.x + p.y * c.y + p.z * c.z + p.w < -sphere.radius) {
            inFrustum = false;
            break;
          }
        }
      } else if (frustum)
        inFrustum =
          frustum.computeVisibility(sphere) !== Cesium.Intersect.OUTSIDE;
      const visible = (frustum || bounds) && horizon && inFrustum;
      const visibility = (entry.visibility ||= {});
      visibility.bounds = bounds;
      visibility.boundsApplied = !frustum;
      visibility.occluder = horizon;
      visibility.frustum = inFrustum;
      visibility.noSample = noSample;
      const wasShown = entry.marker.show;
      const wasVisible = state._visible.has(entry);
      if (visible) state._visible.add(entry);
      else state._visible.delete(entry);
      if (visible && entry.track?.count) {
        if (!wasVisible && !entry.qaFixture) syncPlayback(entry, now);
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
      entry.marker.show =
        visible && !entry.heightPending && entry.surfaceReady !== false;
      visibility.heightPending = !!entry.heightPending;
      visibility.surfaceReady = entry.surfaceReady ?? null;
      schedulePlayback(entry);
      changed ||= visible !== wasVisible || wasShown !== entry.marker.show;
    }
    state._shownCount = state._visible.size;
    if (changed) state._detectRevision++;
    syncRenderHold();
    governorRequestRender('transit-visibility');
    return state._shownCount;
  }
  function resumePlayback() {
    if (!state._enabled) return;
    const now = Date.now(),
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
  }

  let stopProbe = null;
  /** Stop a running frame probe, resolving it with what it has. */
  function stopFrameProbe() {
    stopProbe?.();
  }

  /** Measure inside Cesium postRender with fixed typed storage; no sample objects per frame. */
  function measureFrames(durationMs = 12000) {
    stopProbe?.();
    const scene = state._viewer.scene;
    const capacity = 20000,
      stride = 12,
      data = new Float64Array(capacity * stride);
    const previousPositions = new Float64Array(state._vehicles.size * 3);
    const gl = webglContext(scene);
    let active = false,
      upload = 0,
      cpu = 0,
      count = 0,
      previous = 0;
    const saved = [];
    for (const name of ['bufferData', 'bufferSubData']) {
      const original = gl[name];
      gl[name] = function (...args) {
        if (active) {
          const value = args[name === 'bufferData' ? 1 : 2];
          const offset = args[name === 'bufferData' ? 3 : 3] || 0;
          const length = args[4];
          upload +=
            typeof value === 'number'
              ? value
              : value
                ? length !== undefined
                  ? length * (value.BYTES_PER_ELEMENT || 1)
                  : value.byteLength - offset * (value.BYTES_PER_ELEMENT || 1)
                : 0;
        }
        return original.apply(this, args);
      };
      saved.push(() => {
        gl[name] = original;
      });
    }
    for (const collection of [state._markers, state._animatedMarkers]) {
      const original = collection.update;
      collection.update = function (frame) {
        active = true;
        try {
          return original.call(this, frame);
        } finally {
          active = false;
        }
      };
      saved.push(() => {
        collection.update = original;
      });
    }
    state._preRenderRemove?.();
    const removePre = scene.preRender.addEventListener(() => {
      upload = 0;
      const start = performance.now();
      onPreRender();
      cpu = performance.now() - start;
    });
    let removePost, timer;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        removePre();
        removePost?.();
        for (const restore of saved) restore();
        if (state._enabled)
          state._preRenderRemove =
            scene.preRender.addEventListener(onPreRender);
        stopProbe = null;
        const rows = [];
        for (let i = 1; i < count; i++) {
          const k = i * stride;
          rows.push({
            intervalMs: data[k],
            cpuMs: data[k + 1],
            uploadBytes: data[k + 2],
            moving: data[k + 3],
            x: data[k + 4],
            y: data[k + 5],
            z: data[k + 6],
            displayT: data[k + 7],
            expectedMps: data[k + 8],
            segment: data[k + 9],
          });
        }
        resolve({
          rows,
          dpr: devicePixelRatio,
          width: scene.canvas.clientWidth,
          height: scene.canvas.clientHeight,
        });
      };
      stopProbe = finish;
      removePost = scene.postRender.addEventListener(() => {
        const now = performance.now();
        if (count >= capacity) return;
        const k = count++ * stride;
        const entry = state._vehicles.get('mbta:qa-0');
        data[k] = previous ? now - previous : 0;
        previous = now;
        data[k + 1] = cpu;
        data[k + 2] = upload;
        let actuallyMoved = 0;
        for (const vehicle of state._visible) {
          const p = vehicle.marker.position,
            index = vehicle.qaIndex * 3;
          if (
            count > 1 &&
            Math.hypot(
              p.x - previousPositions[index],
              p.y - previousPositions[index + 1],
              p.z - previousPositions[index + 2],
            ) > 0.00001
          )
            actuallyMoved++;
          previousPositions[index] = p.x;
          previousPositions[index + 1] = p.y;
          previousPositions[index + 2] = p.z;
        }
        data[k + 3] = actuallyMoved;
        if (entry?.marker) {
          const p = entry.marker.position;
          data[k + 4] = p.x;
          data[k + 5] = p.y;
          data[k + 6] = p.z;
          data[k + 7] = entry.sample.displayT;
          data[k + 8] = entry.sample.segmentSpeedMps;
          data[k + 9] = entry.sample.fromSeq;
        }
      });
      timer = setTimeout(finish, durationMs);
    });
  }

  return {
    createMarkers,
    showMarkers,
    clearMarkers,
    destroyMarkers,
    markerShown,
    watchCamera,
    unwatchCamera,
    startFrames,
    stopFrames,
    cameraHeightM,
    globeSurface,
    sampleMeshFloors,
    measureFrames,
    stopFrameProbe,
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
  };
}
