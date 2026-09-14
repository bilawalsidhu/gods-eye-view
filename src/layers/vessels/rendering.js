import * as Cesium from 'cesium';
import {
  vesselTypeCss,
  vesselOverlayCohortLimit,
  VESSEL_OVERLAY_SOURCE_ID,
  applyVesselOverlayPolicy,
  VESSEL_CARD_FADE_DISTANCE_M,
} from '../../data/vesselLabels.js';
import {
  cameraPoseSignature,
  screenProjectedRotation,
} from '../../data/iconOrientation.js';
import {
  DEFAULT_RENDER_ROWS,
  DEFAULT_ACTIVE_LABELS,
  VISIBILITY_UPDATE_MS,
  FOCUS_UPDATE_MS,
  LABEL_GRID_PX,
  CARD_MIN_SEP_PX,
} from './policy.js';

export function createRendering({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { registerSpriteCollection } = services.sprites;
  const {
    forgetSpriteFocus,
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
  } = services.focus;

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

  function ensureCollections(viewer) {
    if (!viewer || state.billboardCollection) return;
    state.billboardCollection = new Cesium.BillboardCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    state.billboardCollection.show = state.enabled;
    viewer.scene.primitives.add(state.billboardCollection);
    registerSpriteCollection('ais', state.billboardCollection);
  }

  /**
   * Create the billboard primitive for a freshly added vessel record. Map labels
   * are canvas cards (vesselLabels.js) rebuilt by the declutter pass — no
   * per-record label primitive exists anymore.
   * @param {Object} record - Normalized vessel record.
   * @param {Cesium.EllipsoidalOccluder|null} occluder - Horizon occluder for initial visibility.
   */

  function addRecordPrimitives(record, occluder) {
    const visible =
      state.enabled && isVisible(record.surfacePosition, occluder);
    record.billboard = state.billboardCollection.add({
      position: record.position,
      show: visible,
      image: shipIcon(record, false),
      scale: shipScale(record),
      // Screen-projected rotation lands on the next visibility/rotation pass.
      rotation: 0,
      alignedAxis: Cesium.Cartesian3.ZERO,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      // Locked height-datum principle #2: contacts are ALWAYS visible —
      // depth-test-free sprites; the EllipsoidalOccluder handles the far side.
      // (The tile sea mesh ≠ the geoid exactly, so a depth-tested chevron at
      // the geoid still clips out behind local tide/mesh noise.)
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: record,
    });
  }

  /**
   * Remove a record's billboard primitive from its collection.
   * @param {Object} record - Vessel record to tear down.
   */

  function removeRecordPrimitives(record) {
    if (!record) return;
    if (record.billboard && state.billboardCollection) {
      forgetSpriteFocus(record.billboard);
      state.billboardCollection.remove(record.billboard);
    }
    record.billboard = null;
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
   * Screen rotation is computed from this by the shared projected-rotation
   * pass in updateVisibility — never directly from the compass value.
   * @param {Object} record - Vessel record.
   * @returns {number} Course in degrees (0 when unknown).
   */

  function vesselCourseDeg(record) {
    const direction = record.heading ?? record.course;
    return Number.isFinite(direction) ? direction : 0;
  }

  /**
   * Build (and cache) a chevron/delta-wing SVG data URL tinted for the vessel.
   * The shape points north (up) so billboard rotation maps directly to heading.
   * One icon is generated per color+variant and reused across all billboards.
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

  function installRuntime(viewer) {
    if (state.preRenderRemover || !viewer) return;
    state.preRenderRemover = viewer.scene.preRender.addEventListener(() =>
      updateVisibility(),
    );
  }

  function updateVisibility(force = false) {
    if (!state.enabled) return;
    const now = focusNowMs(performance.now());
    const focusTarget = getFocusTarget();
    const regularPass =
      force || now - state.lastVisibilityUpdate >= VISIBILITY_UPDATE_MS;
    const focusPass =
      focusPassIsNeeded(focusTarget, state.activeFocusCount) &&
      (force || now - state.lastFocusUpdate >= FOCUS_UPDATE_MS);
    if (!regularPass && !focusPass) return;
    if (regularPass) state.lastVisibilityUpdate = now;
    if (focusPass) state.lastFocusUpdate = now;
    if (!state.vesselRecords.length) {
      // No records — flush any lingering card entries (vanished-feed case).
      if (regularPass) updateClusteredLabels([]);
      if (focusPass) state.activeFocusCount = 0;
      return;
    }

    const scene = state.viewer?.scene;
    const camera = state.viewer?.camera;
    if (regularPass) {
      // Candidate construction stays on the original 800 ms selector cadence.
      // The 80 ms focus-only pass below never allocates label candidates.
      const poseSig = camera ? cameraPoseSignature(camera) : '';
      const doRotations = force || poseSig !== vesselState._lastCamPoseSig;
      if (doRotations) vesselState._lastCamPoseSig = poseSig;
      const occluder = makeOccluder();
      const labelCandidates = [];
      for (const record of state.vesselRecords) {
        const visible = isVisible(record.surfacePosition, occluder);
        if (record.billboard) {
          record.billboard.show = visible;
          if (visible && doRotations && scene) {
            const rot = screenProjectedRotation(
              scene,
              record.position,
              vesselCourseDeg(record),
              record.billboard.rotation,
            );
            if (
              rot !== null &&
              Math.abs(rot - record.billboard.rotation) > 0.002
            ) {
              record.billboard.rotation = rot;
            }
          }
        }
        if (visible) labelCandidates.push(record);
      }
      updateClusteredLabels(labelCandidates);
    }
    if (focusPass && scene && camera) {
      const result = applyVesselFocusDeemphasis({
        records: state.vesselRecords,
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
    }
  }

  /**
   * Apply focus alpha to vessel sprites. Kept as a production wire seam so the
   * animation/deadband contract can be tested without constructing WebGL.
   * @param {object} input
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyVesselFocusDeemphasis({
    records,
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
      const bb = record?.billboard;
      const position = bb?.position || record?.position;
      if (!bb || !position) continue;
      const focus = advanceSpriteFocus(bb, {
        // Hidden/far-side sprites still finish any pending release so the active
        // count remains truthful and they cannot reappear with stale dim alpha.
        screenPosition: bb.show === false ? null : screenPositionFor(position),
        cameraDistance: cameraDistanceFor(position),
        nowMs,
        target,
        params,
        // Vessel artwork is 32 px before billboard scale. Including the
        // ambient chevron's own rendered extent prevents edge-overlap misses.
        spriteHalfWidthPx: (bb.width || 32) * (bb.scale || 1) * 0.5,
        spriteHalfHeightPx: (bb.height || 32) * (bb.scale || 1) * 0.5,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      if (focusAlphaNeedsWrite(bb.color?.alpha, focus.factor, params)) {
        // Narrow always-visible amendment: the ship chevron remains present at
        // the non-zero floor while it competes with the tracked target. Preserve
        // the billboard's existing base RGB, matching the other layer patterns,
        // rather than repainting every chevron from a hard-coded WHITE base.
        const baseColor = bb.color || Cesium.Color.WHITE;
        bb.color = baseColor.withAlpha(focus.factor);
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

  function isVisible(surfacePosition, occluder) {
    if (!surfacePosition || !occluder) return true;
    return occluder.isPointVisible(surfacePosition);
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
      if (record === selected) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        record.position,
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
        selected.billboard?.position || selected.position,
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
          accessibilityLabel: `Focus vessel ${card.title}, MMSI ${mmsi}`,
          activate: () => {
            const record = state.vesselMap.get(mmsi);
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
    if (state.billboardCollection) {
      state.billboardCollection.show = show;
    }
    vesselState._vesselOverlayHost.setVisible(VESSEL_OVERLAY_SOURCE_ID, show);
  }
  return {
    renderRowLimit,
    labelRowLimit,
    ensureCollections,
    addRecordPrimitives,
    removeRecordPrimitives,
    shipScale,
    vesselCourseDeg,
    shipIcon,
    installRuntime,
    updateVisibility,
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
