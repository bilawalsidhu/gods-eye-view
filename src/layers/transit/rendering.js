import * as Cesium from 'cesium';
import { perspectiveProjectedRotation } from '../../data/iconOrientation.js';
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
  MARKER_PIXEL_SIZE,
  ROTATION_REFRESH_MS,
  SELECTED_CARD_REFRESH_MS,
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
    if (
      state._rotationRevision === state._cameraRevision &&
      !state._rotationDirty &&
      state._moving.size === 0
    )
      return;
    state._rotationAt = now;
    const cameraChanged = state._rotationRevision !== state._cameraRevision;
    state._rotationRevision = state._cameraRevision;
    state._rotationDirty = false;
    for (const entry of state._visible) {
      if (entry.key === state._selectedKey) continue;
      const course = entry.courseDeg;
      if (course === null) continue;
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
    if (
      selected &&
      state._visible.has(selected) &&
      selected.courseDeg !== null
    ) {
      selected.marker.rotation = perspectiveProjectedRotation(
        state._viewer.scene,
        selected.marker.position,
        selected.courseDeg,
        selected.marker.rotation,
      );
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
        // Surface completion must recover while requestRenderMode is idle.
        // Otherwise surfaceReady=false prevents the very frame that clears it.
        if (!state._moving.has(entry)) {
          updatePlayback(entry, now, performance.now());
          placeSample(entry);
        }
      }
      entry.marker.show =
        visible && !entry.heightPending && entry.surfaceReady !== false;
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

  return {
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
