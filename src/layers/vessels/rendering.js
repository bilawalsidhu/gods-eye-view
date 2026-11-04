import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  vesselTypeCss,
  vesselOverlayCohortLimit,
  VESSEL_OVERLAY_SOURCE_ID,
  applyVesselOverlayPolicy,
  VESSEL_CARD_FADE_DISTANCE_M,
} from '../../data/vesselLabels.js';
import { cameraPoseSignature } from '../../data/iconOrientation.js';
import {
  createIconSet,
  ICON_CULL_LIFT,
  ICON_ROTATES,
} from '../../data/iconSet.js';
import { writeHoldSegment } from '../../data/iconSegment.js';
import { IconSetPrimitive } from '../../data/iconSetPrimitive.js';
import { iconAtlas } from '../../data/iconAtlas.js';
import {
  VESSEL_LIFT_M,
  DEFAULT_RENDER_ROWS,
  DEFAULT_ACTIVE_LABELS,
  VISIBILITY_UPDATE_MS,
  FOCUS_UPDATE_MS,
  LABEL_GRID_PX,
  CARD_MIN_SEP_PX,
} from './policy.js';

/** The ship artwork's own raster size (px). */
const SHIP_ICON_PX = 32;

export function createRendering({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  let visualRecords = new WeakMap();

  // The fallback preserves helper calls with externally supplied render records.
  function getVisual(record) {
    return visualRecords.get(record) || record;
  }

  /** Where a record's icon is drawn: its row holds at the visual position. */
  function iconPosition(record) {
    return getVisual(record).position;
  }

  function prepareRecordVisual(record) {
    let visual = visualRecords.get(record);
    if (!visual) {
      // Unkeyed records (no MMSI) are rebuilt every poll, so their rows take
      // a fresh id that no MMSI can collide with.
      visual = {
        iconId:
          record.mmsi || `ais-unkeyed:${++vesselState._unkeyedIconSequence}`,
        visible: false,
      };
      visualRecords.set(record, visual);
    }
    const heightM = components.queries.vesselDatumHeightM(
      components.tracking.currentGeoidN(record.lat, record.lon),
      VESSEL_LIFT_M,
    );
    visual.position = Cesium.Cartesian3.fromDegrees(
      record.lon,
      record.lat,
      heightM,
    );
    return visual;
  }

  function resetRecordVisuals() {
    visualRecords = new WeakMap();
  }

  const { registerSpriteCollection } = services.sprites;
  const {
    forgetSpriteFocus,
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
    spriteFocusAtRest,
  } = services.focus;
  const {
    holdContinuousRender,
    releaseContinuousRender,
    governorRequestRender,
  } = services.render;

  function renderRowLimit() {
    const configured = Number(options.maxRows);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(500, Math.min(50000, Math.round(configured)));
    }
    return DEFAULT_RENDER_ROWS;
  }

  function labelRowLimit() {
    const configured = Number(options.maxLabels);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.max(0, Math.min(renderRowLimit(), Math.round(configured)));
    }
    return Math.min(DEFAULT_ACTIVE_LABELS, renderRowLimit());
  }

  /**
   * The layer's icon set and its primitive. Vessels hold still between polls,
   * so each row is a hold segment and the primitive's clock only keeps segment
   * times small. The set draws depth-test-free on the near plane and culls the
   * far side on the GPU (locked height-datum principle #2: contacts are ALWAYS
   * visible; the tile sea mesh ≠ the geoid, so a depth-tested chevron at the
   * geoid would clip behind local tide/mesh noise).
   */
  function ensureCollections(viewer) {
    if (!viewer || state.icons) return;
    const epoch = Cesium.JulianDate.now();
    state.icons = createIconSet({ epoch });
    state.icons.show = state.feed.enabled;
    state.iconPrimitive = new IconSetPrimitive({
      set: state.icons,
      renderTime: () => epoch,
      requestRender: () => governorRequestRender('ais-vessels-icons'),
    });
    viewer.scene.primitives.add(state.iconPrimitive);
    registerSpriteCollection('ais', state.iconPrimitive);
  }

  /**
   * Add a freshly added vessel record's icon row. Map labels are canvas cards
   * (vesselLabels.js) rebuilt by the declutter pass — no per-record label
   * primitive exists anymore.
   * @param {Object} record - Normalized vessel record.
   * @param {Cesium.EllipsoidalOccluder|null} occluder - Horizon occluder for initial visibility.
   */

  function addRecordPrimitives(record, occluder) {
    const visual = getVisual(record);
    const set = state.icons;
    const row = set.add(visual.iconId, {
      layer: 'ais-live-vessels',
      id: visual.iconId,
    });
    set.setSize(row, SHIP_ICON_PX, SHIP_ICON_PX);
    set.setFlag(row, ICON_ROTATES, true);
    // Sea level sits at geoid N, below the ellipsoid across much of the ocean.
    set.setFlag(row, ICON_CULL_LIFT, true);
    set.setShown(row, true);
    syncRecordIcon(record);
    visual.visible = isVisible(visual.cullPosition, occluder);
  }

  /**
   * Write a record's row from its visual position, course, tint and selection,
   * and keep the point the shader judges the horizon at (`cullPosition`) so
   * the CPU card/focus pass draws the same boundary.
   * @param {Object} record - Vessel record with a prepared visual.
   */

  function syncRecordIcon(record) {
    const visual = getVisual(record);
    const set = state.icons;
    const row = set?.row(visual.iconId) ?? -1;
    if (row < 0 || !visual.position) return;
    const selected = record === state.selectedRecord;
    const slot = iconAtlas.slot(shipIcon(record, selected), SHIP_ICON_PX);
    set.setImage(row, slot, slot);
    set.setScale(row, shipScale(record) * (selected ? 1.2 : 1));
    writeHoldSegment(
      set.segments,
      row,
      visual.position,
      vesselCourseDeg(record),
    );
    set.segmentWritten(row);
    visual.cullPosition = set.cullPoint(
      row,
      visual.position,
      visual.cullPosition,
    );
  }

  /**
   * Remove a record's icon row.
   * @param {Object} record - Vessel record to tear down.
   */

  function removeRecordPrimitives(record) {
    if (!record) return;
    const set = state.icons;
    const visual = getVisual(record);
    const row = set?.row(visual.iconId) ?? -1;
    if (row < 0) return;
    forgetSpriteFocus(set.metaAt(row));
    set.remove(visual.iconId);
  }

  function shipScale(record) {
    const speed = Number(record.speed || 0);
    if (speed >= 18) return 0.78;
    if (speed >= 8) return 0.68;
    return 0.6;
  }

  /**
   * Best available real-world direction of travel for a vessel, degrees
   * clockwise from north (true heading preferred, course-over-ground fallback).
   * The icon set turns this into its screen rotation on the GPU each frame.
   * @param {Object} record - Vessel record.
   * @returns {number} Course in degrees (0 when unknown).
   */

  function vesselCourseDeg(record) {
    const direction = record.heading ?? record.course;
    return Number.isFinite(direction) ? direction : 0;
  }

  /**
   * Build (and cache) a chevron/delta-wing SVG data URL tinted for the vessel.
   * The shape points north (up) so the row's course maps directly to heading.
   * One icon is generated per color+variant and shares one atlas slot.
   * @param {Object} record - Vessel record (drives per-type tint).
   * @param {boolean} selected - True for the white/brighter selected variant.
   * @returns {string} SVG data URL.
   */

  function shipIcon(record, selected) {
    const cssColor = selected ? '#ffffff' : vesselTypeCss(record.type);
    const key = `${cssColor}:${selected ? 'selected' : 'normal'}`;
    if (vesselState.shipIconCache.has(key))
      return vesselState.shipIconCache.get(key);

    const stroke = selected ? 'rgba(6,26,32,0.95)' : 'rgba(4,18,24,0.9)';
    const strokeWidth = selected ? 1.1 : 0.7;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="translate(16,16)">
      <path d="M0,-14 L11,10 L4,7 L0,14 L-4,7 L-11,10 Z" fill="${cssColor}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
    </g>
  </svg>`;
    const icon = 'data:image/svg+xml;base64,' + btoa(svg);
    vesselState.shipIconCache.set(key, icon);
    return icon;
  }

  // Vessels move only when a poll lands, so the layer does not hold the
  // continuous render loop. Its passes run in preRender, which idle mode fires
  // only for rendered frames: a forced pass (new data, selection) requests its
  // frame, a frame that moved the camera but fell inside the 800 ms cadence
  // leaves a trailing frame so the view the camera stopped on is always
  // evaluated, and the continuous hold is kept only while focus emphasis is
  // animating. The trailing frame is keyed to camera motion alone: the pass's
  // own label publication requests a frame, and scheduling on that would loop.
  function installRuntime(viewer) {
    if (state.preRenderRemover || !viewer) return;
    state.preRenderRemover = viewer.scene.preRender.addEventListener(() =>
      updateVisibility(),
    );
  }

  function scheduleTrailingVisibilityPass(now) {
    if (state.trailingVisibilityTimer) return;
    const waitMs = Math.max(
      0,
      VISIBILITY_UPDATE_MS - (now - state.lastVisibilityUpdate),
    );
    state.trailingVisibilityTimer = vesselState._aisRuntime.setTimeout(() => {
      state.trailingVisibilityTimer = null;
      if (state.feed.enabled) governorRequestRender('ais-vessels-visibility');
    }, waitMs);
  }

  function cancelTrailingVisibilityPass() {
    if (!state.trailingVisibilityTimer) return;
    vesselState._aisRuntime.clearTimeout(state.trailingVisibilityTimer);
    state.trailingVisibilityTimer = null;
  }

  function updateVisibility(force = false) {
    if (!state.feed.enabled) return;
    if (force) governorRequestRender('ais-vessels-update');
    const now = focusNowMs(performance.now());
    const focusTarget = getFocusTarget();
    const regularPass =
      force || now - state.lastVisibilityUpdate >= VISIBILITY_UPDATE_MS;
    const focusPass =
      focusPassIsNeeded(focusTarget, state.activeFocusCount) &&
      (force || now - state.lastFocusUpdate >= FOCUS_UPDATE_MS);
    if (
      !regularPass &&
      state.viewer?.camera &&
      cameraPoseSignature(state.viewer.camera) !== vesselState._lastCamPoseSig
    )
      scheduleTrailingVisibilityPass(now);
    if (!regularPass && !focusPass) return;
    if (regularPass) state.lastVisibilityUpdate = now;
    if (focusPass) state.lastFocusUpdate = now;
    if (!state.records.all.length) {
      // No records — flush any lingering card entries (vanished-feed case).
      // Still record the pose this pass evaluated, or every later frame that
      // falls inside the cadence would schedule another trailing frame.
      if (regularPass) {
        if (state.viewer?.camera)
          vesselState._lastCamPoseSig = cameraPoseSignature(
            state.viewer.camera,
          );
        updateClusteredLabels([]);
      }
      if (focusPass) {
        state.activeFocusCount = 0;
        releaseContinuousRender('ais-vessels');
      }
      return;
    }

    const scene = state.viewer?.scene;
    const camera = state.viewer?.camera;
    if (regularPass) {
      // Candidate construction stays on the original 800 ms selector cadence.
      // The 80 ms focus-only pass below never allocates label candidates.
      // Icons cull and rotate on the GPU; this pass only picks the cards and
      // remembers which vessels the horizon leaves in view for focus.
      if (camera) vesselState._lastCamPoseSig = cameraPoseSignature(camera);
      const occluder = makeOccluder();
      const labelCandidates = [];
      for (const record of state.records.all) {
        const visual = getVisual(record);
        visual.visible = isVisible(visual.cullPosition, occluder);
        if (visual.visible) labelCandidates.push(record);
      }
      updateClusteredLabels(labelCandidates);
    }
    if (focusPass && scene && camera) {
      const result = applyVesselFocusDeemphasis({
        records: state.records.all,
        target: focusTarget,
        previousActiveCount: state.activeFocusCount,
        nowMs: now,
        screenPositionFor: (position) =>
          Cesium.SceneTransforms.worldToWindowCoordinates(
            scene,
            position,
            vesselState._scratchFocusScreen,
          ),
        cameraDistanceFor: (position) =>
          Cesium.Cartesian3.distance(camera.positionWC, position),
      });
      state.activeFocusCount = result.activeCount;
      if (result.activeCount > 0 || result.transitioning)
        holdContinuousRender('ais-vessels');
      else releaseContinuousRender('ais-vessels');
    }
  }

  /**
   * Apply focus emphasis to vessel icons through the set's focus column
   * (narrow always-visible amendment: the ship chevron remains present at the
   * non-zero floor while it competes with the tracked target). Kept as a
   * production wire seam so the animation/deadband contract can be tested
   * without constructing WebGL.
   * @param {object} input
   * @param {object} [input.icons] The icon set (defaults to the layer's).
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyVesselFocusDeemphasis({
    records,
    icons = state.icons,
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
    for (const record of records || []) {
      const visual = getVisual(record);
      const row = icons?.row(visual?.iconId) ?? -1;
      const position = visual?.position;
      if (row < 0 || !position) continue;
      const sprite = icons.metaAt(row);
      // Most of a worldwide feed sits behind the horizon. A hidden icon with
      // no pending focus state at full emphasis would advance to exactly what
      // it already is, so skip it instead of paying its distance and state
      // work every 80 ms while anything is tracked.
      if (
        !visual.visible &&
        spriteFocusAtRest(sprite) &&
        !focusAlphaNeedsWrite(icons.focus(row), 1, params)
      )
        continue;
      const focus = advanceSpriteFocus(sprite, {
        // Hidden/far-side icons still finish any pending release so the active
        // count remains truthful and they cannot reappear with stale dim alpha.
        screenPosition: visual.visible ? screenPositionFor(position) : null,
        cameraDistance: cameraDistanceFor(position),
        nowMs,
        target,
        params,
        // Vessel artwork is 32 px before scale. Including the ambient
        // chevron's own rendered extent prevents edge-overlap misses.
        spriteHalfWidthPx: icons.width(row) * icons.scale(row) * 0.5,
        spriteHalfHeightPx: icons.height(row) * icons.scale(row) * 0.5,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      if (focusAlphaNeedsWrite(icons.focus(row), focus.factor, params)) {
        icons.setFocus(row, focus.factor);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }

  function makeOccluder() {
    const cameraPosition = state.viewer?.camera?.positionWC;
    if (!cameraPosition) return null;
    return new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      cameraPosition,
    );
  }

  function isVisible(cullPosition, occluder) {
    if (!cullPosition || !occluder) return true;
    return occluder.isPointVisible(cullPosition);
  }

  /**
   * Source selector for the shared world-overlay pipeline: the
   * grid declutter picks which vessels get cards — one winner per screen-space
   * grid cell, priority-ranked, capped — and publishes presentation entries to
   * the host, which owns projection, final placement, fade and paint. Runs on the
   * throttled visibility pass and forced refreshes, never per frame. The
   * selected vessel always gets its full-detail card, even when horizon-culled
   * from the ambient candidates; its protected entry bypasses ambient quotas.
   * @param {Array<Object>} records - Horizon-visible vessel records.
   */

  function updateClusteredLabels(records) {
    const viewer = state.viewer;
    const scene = viewer?.scene;
    const selected = state.selectedRecord;
    const entries = selected
      ? [components.cards.buildSelectedVesselCard(selected)]
      : [];
    const maxLabels = labelRowLimit();

    if (!scene || !records.length || maxLabels <= 0) {
      state.activeLabelCount = entries.length;
      publishVesselOverlayEntries(entries);
      return;
    }

    const cells = new Map();
    for (const record of records) {
      const visual = getVisual(record);
      if (record === selected) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        visual.position,
      );
      if (!screen) continue;
      const key = `${Math.floor(screen.x / LABEL_GRID_PX)}:${Math.floor(screen.y / LABEL_GRID_PX)}`;
      const candidate = {
        record,
        score: labelPriority(record, selected),
        x: screen.x,
        y: screen.y,
      };
      const existing = cells.get(key);
      if (!existing || candidate.score > existing.score) {
        cells.set(key, candidate);
      }
    }

    // Greedy min-separation pass over the priority-ranked cell winners: the
    // selected card's anchor seeds the accepted set so ambient cards keep clear.
    const accepted = [];
    if (selected) {
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        iconPosition(selected),
      );
      if (screen) accepted.push({ x: screen.x, y: screen.y });
    }
    const ranked = [...cells.values()].sort((a, b) => b.score - a.score);
    for (const candidate of ranked) {
      if (entries.length >= maxLabels) break;
      if (
        !components.cards.cardScreenSeparated(
          accepted,
          candidate,
          CARD_MIN_SEP_PX,
        )
      )
        continue;
      accepted.push({ x: candidate.x, y: candidate.y });
      entries.push(components.cards.buildVesselCard(candidate.record));
    }
    state.activeLabelCount = entries.length;
    publishVesselOverlayEntries(entries);
  }

  /**
   * Publish a complete, bounded source snapshot to the shared host. The source
   * selector remains authoritative for the 118 px grid and 150 px separation;
   * the host then composes this demand with sibling ambient-card sources.
   * @param {Object[]} entries Formatted vessel card entries.
   */

  function publishVesselOverlayEntries(entries) {
    const canvas = state.viewer?.scene?.canvas || state.viewer?.canvas;
    const width = Number(canvas?.clientWidth) || 0;
    const height = Number(canvas?.clientHeight) || 0;
    const ambientLimit = vesselOverlayCohortLimit(
      width,
      height,
      labelRowLimit(),
    );
    vesselState._vesselOverlayHost.setEntries(
      VESSEL_OVERLAY_SOURCE_ID,
      entries.map((entry) => {
        const card = applyVesselOverlayPolicy(
          entry,
          VESSEL_CARD_FADE_DISTANCE_M,
        );
        if (!card.interactive) return card;
        const mmsi = String(card.id || '').startsWith('vessel:')
          ? card.id.slice('vessel:'.length)
          : '';
        return {
          ...card,
          accessibilityLabel: t('Focus vessel {name}, MMSI {mmsi}', {
            name: card.title,
            mmsi,
          }),
          activate: () => {
            const record = state.records.byMmsi.get(mmsi);
            if (!record) return false;
            components.selection.selectAndFocusVessel(record);
            return true;
          },
        };
      }),
      {
        cohortLimit: Math.max(1, ambientLimit),
        collisionCapacity: ambientLimit,
        moving: false,
      },
    );
  }

  function labelPriority(record, selected) {
    if (record === selected) return 100000;
    let score = 0;
    if (hasUsefulName(record)) score += 1000;
    if (record.speed !== null)
      score += Math.min(400, Math.max(0, record.speed) * 20);
    if (record.heading !== null || record.course !== null) score += 80;
    if (record.type) score += 40;
    return score;
  }

  function hasUsefulName(record) {
    const text = String(record.name || '').trim();
    return Boolean(
      text &&
      text !== 'VESSEL' &&
      !/^MMSI\s*\d+$/i.test(text) &&
      text !== record.mmsi,
    );
  }

  function setVisible(show) {
    if (state.icons) state.icons.show = show;
    vesselState._vesselOverlayHost.setVisible(VESSEL_OVERLAY_SOURCE_ID, show);
  }
  return {
    getVisual,
    iconPosition,
    prepareRecordVisual,
    resetRecordVisuals,
    renderRowLimit,
    labelRowLimit,
    ensureCollections,
    addRecordPrimitives,
    syncRecordIcon,
    removeRecordPrimitives,
    shipScale,
    vesselCourseDeg,
    shipIcon,
    installRuntime,
    updateVisibility,
    cancelTrailingVisibilityPass,
    applyVesselFocusDeemphasis,
    makeOccluder,
    isVisible,
    updateClusteredLabels,
    publishVesselOverlayEntries,
    labelPriority,
    hasUsefulName,
    setVisible,
  };
}
