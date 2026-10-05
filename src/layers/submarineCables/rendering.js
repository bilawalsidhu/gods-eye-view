import * as Cesium from 'cesium';
import {
  probeTranslucentMarkerBlend,
  commitTranslucentMarkerBlend,
} from './surface.js';
import {
  clampLabel,
  createCableOverlayEntry,
  updateCableReferenceStem,
  selectCableReferenceLabelWinners,
  cableReferencePriority,
} from './overlay.js';

export function createRendering({ state }) {
  function resetPublishSignature() {
    state._lastPublishedIds.length = 0;
    state._lastPublishedPriorities.length = 0;
    state._lastPublishedCount = -1;
  }

  /**
   * Remove the three data sources from the viewer and forget the built
   * entities. Hiding them (`show = false`) is NOT enough: Cesium's
   * DataSourceDisplay still walks every visualizer of a hidden source on
   * every frame, and the thousands of hidden polylines/billboards keep
   * costing CPU and GC pressure long after the user toggled the layer off —
   * that is the "everything gets sluggish after I turn layers off" report.
   * The fetched JSON stays cached, so the next enable rebuilds without a
   * network round trip or a re-parse.
   */

  function releaseDataSources(viewer) {
    const sources = [
      state._cableDataSource,
      state._landingDataSource,
      state._referenceDataSource,
    ];
    state._cableDataSource = null;
    state._landingDataSource = null;
    state._referenceDataSource = null;
    state._referenceRecords = [];
    state._surfaceRecords = [];
    state._pickByEntity = new WeakMap();
    state._referenceLabelCount = 0;
    state._publishScratch.length = 0;
    // The blend pass targets the collections being dropped; the rebuilt
    // sources need their own pass.
    state._markerBlendDone = false;
    state._loaded = false;
    state._referenceSweepGate.reset();
    for (const source of sources) {
      if (!source) continue;
      try {
        viewer?.dataSources?.remove(source, true);
      } catch {
        /* collection gone */
      }
    }
  }

  function updateVisibility() {
    if (state._cableDataSource) state._cableDataSource.show = state._enabled;
    if (state._landingDataSource)
      state._landingDataSource.show = state._enabled;
    if (state._referenceDataSource)
      state._referenceDataSource.show = state._enabled;
  }

  function styleCableEntity(entity, feature) {
    if (!entity?.polyline) return;
    const color = feature?.properties?.color
      ? Cesium.Color.fromCssColorString(String(feature.properties.color))
      : state.cableColor;
    entity.polyline.material = color.withAlpha(0.92);
    entity.polyline.width = 2.5;
    entity.polyline.clampToGround = true;
    entity.polyline.classificationType = state._classificationType;
    entity.show = true;
  }

  /**
   * Apply the single translucent blend pass to the landing-billboard and
   * reference-point collections. Landing entities carry only billboards and
   * reference entities only points, so completion is one applied collection
   * per source; a failed shape probe disables the optimization permanently
   * for this session and says so loudly in dev builds.
   * Both sources are probed BEFORE either is committed, so the helper's
   * "defaults untouched on shape drift" fallback holds across the pair too —
   * a reference-source failure can never leave the landing source already
   * forced to TRANSLUCENT.
   */

  function applyMarkerBlendOnce() {
    const landing = probeTranslucentMarkerBlend(state._landingDataSource);
    const reference = probeTranslucentMarkerBlend(state._referenceDataSource);
    if (landing.invariantFailed || reference.invariantFailed) {
      state._markerBlendDone = true;
      if (!state._markerBlendInvariantWarned && import.meta.env?.DEV === true) {
        state._markerBlendInvariantWarned = true;
        console.error(
          '[Data:telegeography-submarine-cables] EntityCluster marker-collection ' +
            'shape changed — single-pass translucent blend skipped; markers fall ' +
            "back to Cesium's default two-pass blend.",
        );
      }
      return;
    }
    const landingBlend = commitTranslucentMarkerBlend(landing);
    const referenceBlend = commitTranslucentMarkerBlend(reference);
    if (landingBlend.applied > 0 && referenceBlend.applied > 0)
      state._markerBlendDone = true;
  }

  /**
   * Re-classify every cable ground line for the active surface. One batched
   * ground-primitive rebuild per stack switch — never per frame.
   * @param {Cesium.ClassificationType} next
   */

  function applyCableClassification(next) {
    if (next === undefined || next === state._classificationType) return;
    state._classificationType = next;
    if (!state._cableDataSource) return;
    const entities = state._cableDataSource.entities.values;
    for (let i = 0; i < entities.length; i++) {
      const polyline = entities[i].polyline;
      if (polyline) polyline.classificationType = next;
    }
    state._viewer?.scene?.requestRender?.();
  }

  function styleLandingEntity(entity, feature) {
    if (!entity?.point) return;
    entity.point.color = state.landingColor.withAlpha(0.92);
    entity.point.pixelSize = feature?.properties?.is_tbd ? 6 : 7;
    entity.point.outlineColor = state.cableOutline;
    entity.point.outlineWidth = 1;
    entity.point.disableDepthTestDistance = 0;
    entity.show = true;
  }

  function addReferenceStem({ reference, label, kind, color, feature }) {
    if (!state._referenceDataSource || !reference) return;

    const base = Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 0);
    const tip = Cesium.Cartesian3.fromDegrees(
      reference.lon,
      reference.lat,
      2500,
    );
    const info = {
      kind,
      reference,
      label,
      featureId: feature?.id || feature?.properties?.id || null,
    };
    const pointColor = color.withAlpha(kind === 'cable' ? 0.84 : 0.94);
    const stemColor = color.withAlpha(kind === 'cable' ? 0.58 : 0.68);
    // Constant properties on the sweep cadence, never per-frame callbacks:
    // the sweep redefines them through the alternating buffers below.
    const stemPositionBuffers = [
      [base, tip],
      [base, tip],
    ];

    const entity = state._referenceDataSource.entities.add({
      id: `${kind}-reference-${state._referenceRecords.length}-${info.featureId || 'feature'}`,
      position: tip,
      polyline: {
        positions: stemPositionBuffers[0],
        width: kind === 'cable' ? 2 : 2.4,
        material: new Cesium.ColorMaterialProperty(stemColor),
      },
      point: {
        pixelSize: kind === 'cable' ? 7 : 8,
        color: pointColor,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
        outlineWidth: 1,
        disableDepthTestDistance: 0,
      },
    });

    entity.__gevTeleGeography = info;
    state._pickByEntity.set(entity, info);
    const record = {
      id: entity.id,
      entity,
      base,
      tip,
      nextTip: Cesium.Cartesian3.clone(tip),
      stemPositionBuffers,
      stemPositionBufferIndex: 0,
      reference,
      kind,
      label: clampLabel(label),
      visible: false,
      distanceM: Infinity,
      entry: null,
    };
    record.entry = createCableOverlayEntry(record);
    state._referenceRecords.push(record);
  }

  function updateReferenceVisibility() {
    if (!state._enabled || !state._viewer?.camera) return;
    const cameraPos = state._viewer.camera.positionWC;
    if (!cameraPos) return;

    const canvasHeight = state._viewer.scene?.canvas?.clientHeight || 1080;
    const fov = state._viewer.camera.frustum?.fov || Math.PI / 3;
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      cameraPos,
    );
    for (const record of state._referenceRecords) {
      const visible = occluder.isPointVisible(record.base);
      record.visible = visible;
      record.distanceM = Cesium.Cartesian3.distance(cameraPos, record.base);
      if (record.entity.show !== visible) {
        record.entity.show = visible;
      }
      // Hidden stems keep their last geometry; this same sweep refreshes them
      // in the pass where they turn visible again.
      if (visible)
        updateCableReferenceStem(record, cameraPos, canvasHeight, fov);
    }
    for (const record of state._surfaceRecords) {
      const visible = occluder.isPointVisible(record.base);
      if (record.entity.show !== visible) {
        record.entity.show = visible;
      }
    }
    const winners = selectCableReferenceLabelWinners(state._referenceRecords);
    let changed = winners.length !== state._lastPublishedCount;
    for (let i = 0; i < winners.length; i++) {
      const record = winners[i];
      const priority = cableReferencePriority(record.distanceM);
      record.entry.priority = priority;
      state._publishScratch[i] = record.entry;
      if (
        !changed &&
        (state._lastPublishedIds[i] !== record.entry.id ||
          state._lastPublishedPriorities[i] !== priority)
      ) {
        changed = true;
      }
    }
    state._publishScratch.length = winners.length;
    state._referenceLabelCount = winners.length;
    // The marker collections are created lazily by the visualizers, so the
    // single-pass blend is applied on the sweep cadence until both landed.
    if (!state._markerBlendDone) applyMarkerBlendOnce();
    if (!changed) return;
    state._overlayPublisher.publish(state._publishScratch);
    state._lastPublishedCount = winners.length;
    for (let i = 0; i < winners.length; i++) {
      state._lastPublishedIds[i] = state._publishScratch[i].id;
      state._lastPublishedPriorities[i] = state._publishScratch[i].priority;
    }
    state._lastPublishedIds.length = winners.length;
    state._lastPublishedPriorities.length = winners.length;
  }
  return {
    resetPublishSignature,
    releaseDataSources,
    updateVisibility,
    styleCableEntity,
    applyMarkerBlendOnce,
    applyCableClassification,
    styleLandingEntity,
    addReferenceStem,
    updateReferenceVisibility,
  };
}
