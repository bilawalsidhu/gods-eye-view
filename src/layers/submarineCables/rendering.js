import * as Cesium from 'cesium';
import {
  CABLE_LANDING_REVEALS_PER_FRAME,
  CABLE_MARKER_SIZE,
} from './policy.js';
import {
  clampLabel,
  createCableOverlayEntry,
  updateCableReferenceStem,
  selectCableReferenceLabelWinners,
  cableReferencePriority,
} from './overlay.js';

const defaultMarkerImage = (color) =>
  new Cesium.PinBuilder().fromColor(color, CABLE_MARKER_SIZE);

export function createRendering({
  state,
  createMarkerImage = defaultMarkerImage,
}) {
  function resetPublishSignature() {
    state._lastPublishedIds.length = 0;
    state._lastPublishedPriorities.length = 0;
    state._lastPublishedCount = -1;
  }

  /**
   * Build everything the layer draws, in one synchronous pass with no entity
   * per feature. The layer used to load two GeoJsonDataSources and a
   * CustomDataSource: 6,459 entities whose creation held about 1 GB of
   * short-lived heap, whose visualizers ran 100–250 ms tasks whenever shows
   * or stems changed, and whose removal on disable was a 150 ms task. These
   * are the primitives Cesium built from those entities, made directly:
   *
   * - lines: one GroundPolylinePrimitive, a colour and a show flag per line
   *   (Cesium's own batch for clamped colour polylines), tessellated in a
   *   worker;
   * - point markers: one BillboardCollection, each billboard hidden and
   *   unclamped until revealLandingMarkers puts it on the ground;
   * - references: one PointPrimitiveCollection for the tips, whose positions
   *   and shows are plain buffer writes, and one Primitive of polylines for
   *   the stems (see rebuildStems).
   *
   * `lines`, `markers` and `references` come from ingestion; each line and
   * marker carries the pick record Cesium returns as the pick id.
   */

  function buildScene(viewer, { lines, markers, references }) {
    const scene = viewer.scene;
    state._lineRecords = [];
    state._markerRecords = [];
    state._referenceRecords = [];
    state._pendingLandingReveals.length = 0;

    if (lines.length) {
      // The entity display gave every line this attribute too. It is a float
      // attribute, and with one present Cesium keeps the per-line width as a
      // float; without it the 2.5 px width is stored as a byte and draws 2 px.
      const always =
        Cesium.DistanceDisplayConditionGeometryInstanceAttribute.fromDistanceDisplayCondition(
          new Cesium.DistanceDisplayCondition(),
        );
      const instances = lines.map(
        (line) =>
          new Cesium.GeometryInstance({
            id: line.info,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: line.positions,
              width: line.width,
              // GeoJSON lines are rhumb lines (GeoJsonDataSource's choice).
              arcType: Cesium.ArcType.RHUMB,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                line.color,
              ),
              show: new Cesium.ShowGeometryInstanceAttribute(true),
              distanceDisplayCondition: always,
            },
          }),
      );
      state._cablePrimitive = scene.groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: state._classificationType,
          asynchronous: true,
          show: state._enabled,
        }),
      );
      for (const line of lines)
        state._lineRecords.push({
          info: line.info,
          base: line.base,
          visible: true,
          shown: true,
          attributes: null,
        });
    }

    if (markers.length) {
      // Every marker is translucent, so one blend pass, not Cesium's two.
      const billboards = scene.primitives.add(
        new Cesium.BillboardCollection({
          scene,
          blendOption: Cesium.BlendOption.TRANSLUCENT,
          show: state._enabled,
        }),
      );
      state._markerBillboards = billboards;
      const images = new Map();
      for (const marker of markers) {
        const key = marker.color.toCssHexString();
        let image = images.get(key);
        if (!image) {
          image = {
            id: `gev-cable-marker-${key}`,
            source: createMarkerImage(marker.color),
          };
          images.set(key, image);
        }
        const billboard = billboards.add({
          id: marker.info,
          position: marker.position,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          show: false,
        });
        billboard.setImage(image.id, image.source);
        state._markerRecords.push({
          info: marker.info,
          marker: billboard,
          base: marker.base,
          // A position with its own height is drawn there, as before.
          clamped: marker.hasHeight,
          visible: false,
        });
      }
    }

    if (references.length) {
      state._referencePoints = scene.primitives.add(
        new Cesium.PointPrimitiveCollection({
          blendOption: Cesium.BlendOption.TRANSLUCENT,
          show: state._enabled,
        }),
      );
      for (const reference of references) addReferenceStem(reference);
    }
    state._lineShowDirty = false;
  }

  function addReferenceStem({ reference, label, kind, color, feature }) {
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
    state._pickRecords.add(info);
    const pointColor = color.withAlpha(kind === 'cable' ? 0.84 : 0.94);
    // The tip is moved in place on the sweep cadence (overlay.js), never by a
    // per-frame callback.
    const point = state._referencePoints.add({
      id: info,
      position: tip,
      pixelSize: kind === 'cable' ? 7 : 8,
      color: pointColor,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
      outlineWidth: 1,
      disableDepthTestDistance: 0,
      show: false,
    });
    const record = {
      id: `${kind}-reference-${state._referenceRecords.length}-${info.featureId || 'feature'}`,
      info,
      point,
      base,
      tip,
      nextTip: Cesium.Cartesian3.clone(tip),
      stemColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
        color.withAlpha(kind === 'cable' ? 0.58 : 0.68),
      ),
      stemWidth: kind === 'cable' ? 2 : 2.4,
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

  /**
   * Draw the stems of the references now in view, base to tip. Stems are one
   * static polyline primitive, as the entity display batched them: nothing
   * runs for it per frame, and a stem's length cannot change without new
   * geometry. So a sweep that moved a tip or changed which references are
   * in view builds a replacement in a worker, and settleStems swaps it in
   * once it is ready; the previous stems stay until then. A sweep that
   * changed nothing builds nothing.
   */

  function rebuildStems() {
    const primitives = state._viewer?.scene?.primitives;
    if (!primitives) return;
    if (state._stemPrimitivePending) {
      // Superseded before it was ever shown.
      primitives.remove(state._stemPrimitivePending);
      state._stemPrimitivePending = null;
    }
    const instances = [];
    for (const record of state._referenceRecords) {
      if (!record.visible) continue;
      instances.push(
        new Cesium.GeometryInstance({
          id: record.info,
          geometry: new Cesium.PolylineGeometry({
            positions: [record.base, record.tip],
            width: record.stemWidth,
            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: record.stemColor },
        }),
      );
    }
    state._stemsDirty = false;
    if (!instances.length) {
      if (state._stemPrimitive) primitives.remove(state._stemPrimitive);
      state._stemPrimitive = null;
      return;
    }
    state._stemPrimitivePending = primitives.add(
      new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
        asynchronous: true,
        // Hidden while it builds; settleStems shows it.
        show: false,
      }),
    );
    state._viewer.scene.requestRender?.();
  }

  /** Swap in rebuilt stems once their geometry is ready; called per frame. */

  function settleStems() {
    const pending = state._stemPrimitivePending;
    if (!pending) return;
    const scene = state._viewer?.scene;
    if (!pending.ready) {
      // Keep frames coming until the geometry is in.
      scene?.requestRender?.();
      return;
    }
    pending.show = state._enabled;
    if (state._stemPrimitive) scene?.primitives?.remove(state._stemPrimitive);
    state._stemPrimitive = pending;
    state._stemPrimitivePending = null;
    scene?.requestRender?.();
  }

  /** Remove and destroy everything buildScene made. Only destroy() does this;
   * a disable hides the primitives and keeps them for the next enable. */

  function destroyScene(viewer) {
    const scene = viewer?.scene;
    const owned = [
      [scene?.groundPrimitives, state._cablePrimitive],
      [scene?.primitives, state._markerBillboards],
      [scene?.primitives, state._stemPrimitive],
      [scene?.primitives, state._stemPrimitivePending],
      [scene?.primitives, state._referencePoints],
    ];
    state._cablePrimitive = null;
    state._markerBillboards = null;
    state._stemPrimitive = null;
    state._stemPrimitivePending = null;
    state._stemsDirty = false;
    state._referencePoints = null;
    state._referenceRecords = [];
    state._lineRecords = [];
    state._markerRecords = [];
    state._lineShowDirty = false;
    state._pendingLandingReveals.length = 0;
    state._pickRecords = new WeakSet();
    state._referenceLabelCount = 0;
    state._publishScratch.length = 0;
    state._loaded = false;
    state._referenceSweepGate.reset();
    for (const [collection, primitive] of owned) {
      if (!primitive) continue;
      try {
        // A collection destroys what it removes; one that is already gone
        // has destroyed it too.
        if (!collection?.remove?.(primitive) && !primitive.isDestroyed())
          primitive.destroy();
      } catch {
        /* collection gone */
      }
    }
  }

  /**
   * Drop the stems, shown and building, so the next sweep draws them afresh.
   * A disable does this: stems kept from the view the layer was switched off
   * in would show at their old lengths until the rebuild for the new view
   * was ready.
   */

  function dropStems() {
    const primitives = state._viewer?.scene?.primitives;
    for (const primitive of [state._stemPrimitive, state._stemPrimitivePending])
      if (primitive) primitives?.remove(primitive);
    state._stemPrimitive = null;
    state._stemPrimitivePending = null;
    state._stemsDirty = true;
  }

  function updateVisibility() {
    for (const primitive of [
      state._cablePrimitive,
      state._markerBillboards,
      state._stemPrimitive,
      state._referencePoints,
    ])
      if (primitive) primitive.show = state._enabled;
  }

  /**
   * Re-classify the cable ground lines for the active surface. The primitive
   * reads its classification as it queues commands, so this is one
   * assignment per stack switch and no rebuild.
   * @param {Cesium.ClassificationType} next
   */

  function applyCableClassification(next) {
    if (next === undefined || next === state._classificationType) return;
    state._classificationType = next;
    if (!state._cablePrimitive) return;
    state._cablePrimitive.classificationType = next;
    state._viewer?.scene?.requestRender?.();
  }

  /**
   * Write the line show states the last sweep worked out. The primitive
   * builds its geometry in a worker and has no per-line attributes until it
   * is ready, so the states wait in the records until then.
   */

  function syncLineShow() {
    if (!state._lineShowDirty) return;
    const primitive = state._cablePrimitive;
    if (!primitive?.ready) {
      // Keep frames coming until the geometry is in.
      if (primitive) state._viewer?.scene?.requestRender?.();
      return;
    }
    for (const record of state._lineRecords) {
      if (record.shown === record.visible) continue;
      record.attributes ??= primitive.getGeometryInstanceAttributes(
        record.info,
      );
      if (!record.attributes) continue;
      record.attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
        record.visible,
        record.attributes.show,
      );
      record.shown = record.visible;
    }
    state._lineShowDirty = false;
  }

  /**
   * Put the next few markers the last sweep found visible on the ground and
   * show them, and ask for another frame while any are left. Called from the
   * sweep and then once per rendered frame, so a parked camera costs nothing
   * once the list is empty. Clamping is what reads the terrain height, once
   * per marker; Cesium then keeps the marker on the surface as terrain loads,
   * within its own per-frame time budget.
   */

  function revealLandingMarkers() {
    const pending = state._pendingLandingReveals;
    if (!pending.length) return;
    let budget = CABLE_LANDING_REVEALS_PER_FRAME;
    while (pending.length && budget > 0) {
      const record = pending.pop();
      if (!record.visible || record.marker.show) continue;
      if (!record.clamped) {
        record.marker.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
        record.clamped = true;
        budget--;
      }
      record.marker.show = true;
    }
    if (pending.length) state._viewer?.scene?.requestRender?.();
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
      if (record.point.show !== visible) {
        record.point.show = visible;
        state._stemsDirty = true;
      }
      // Hidden stems keep their last tip; this same sweep refreshes them in
      // the pass where they turn visible again.
      if (
        visible &&
        updateCableReferenceStem(record, cameraPos, canvasHeight, fov)
      )
        state._stemsDirty = true;
    }
    if (state._stemsDirty) rebuildStems();
    for (const record of state._lineRecords) {
      record.visible = occluder.isPointVisible(record.base);
      if (record.visible !== record.shown) state._lineShowDirty = true;
    }
    syncLineShow();
    state._pendingLandingReveals.length = 0;
    for (const record of state._markerRecords) {
      const visible = occluder.isPointVisible(record.base);
      record.visible = visible;
      if (record.marker.show === visible) continue;
      // A marker not yet on the ground waits its turn; one that already is
      // shows at once, and hiding is immediate.
      if (visible && !record.clamped) state._pendingLandingReveals.push(record);
      else record.marker.show = visible;
    }
    revealLandingMarkers();
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
    buildScene,
    destroyScene,
    updateVisibility,
    applyCableClassification,
    syncLineShow,
    settleStems,
    dropStems,
    revealLandingMarkers,
    updateReferenceVisibility,
  };
}
