import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { LAYER_ID, MAX_RENDERED, COLOR_BY_CLASS } from './policy.js';

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { floorAltitudeM, cachedGroundFloor } = services.ground;
  const {
    removeEntityContextsForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    selectEntityContext,
  } = services.context;
  const { governorRequestRender } = services.render;
  const { warmFireAnchorFloors } = services.anchors;

  /**
   * Shared rendered-surface height for an installation anchor or footprint.
   * @param {{latitude:number, longitude:number}} record Installation record.
   * @returns {number} Ellipsoidal render height in metres.
   */

  function installationSurfaceHeightM(record) {
    return (
      floorAltitudeM(
        null,
        cachedGroundFloor(record?.latitude, record?.longitude),
      ) ?? 0
    );
  }

  let selectedFillKey = null;
  const selectedFillIds = [];

  function clearSelectionFill() {
    for (const id of selectedFillIds)
      layerState.dataSource?.entities.removeById(id);
    selectedFillIds.length = 0;
    selectedFillKey = null;
  }

  /** Ground geometry classifies the active surface; no height/extrusion plane. */
  function syncSelectionFill() {
    const record =
      layerState.enabled && layerState.recordById.get(layerState.selectedId);
    if (!record) {
      clearSelectionFill();
      return;
    }
    const classificationType =
      layerState.viewer.scene.globe?.show === false
        ? Cesium.ClassificationType.CESIUM_3D_TILE
        : Cesium.ClassificationType.BOTH;
    const key = `${record.id}|${renderKey(record)}|${classificationType}`;
    if (key === selectedFillKey) return;
    clearSelectionFill();
    selectedFillKey = key;
    const footprints =
      record.footprints || (record.footprint ? [[record.footprint]] : []);
    const material = new Cesium.ColorMaterialProperty(
      parts.model.colorFor(record).withAlpha(0.22),
    );
    for (let i = 0; i < footprints.length; i++) {
      const rings = footprints[i];
      const positions = (ring) =>
        ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
      const fill = layerState.dataSource.entities.add({
        id: `${record.id}:selected-fill:${i}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            positions(rings[0]),
            rings
              .slice(1)
              .map((ring) => new Cesium.PolygonHierarchy(positions(ring))),
          ),
          material,
          classificationType,
        },
      });
      fill.installationId = record.id;
      selectedFillIds.push(fill.id);
    }
    governorRequestRender('installation-selection-fill');
  }

  function clearRendered() {
    clearSelectionFill();
    if (layerState.dataSource?.entities)
      layerState.dataSource.entities.removeAll();
    layerState.renderedKeys.clear();
    removeEntityContextsForLayer(LAYER_ID);
  }

  /**
   * Geometry identity of one rendered record. Records whose key is unchanged
   * keep their Cesium entities across refreshes: ground-clamped outlines and
   * classification fills rebuild asynchronously, so recreating them on every
   * reload made unchanged sites blink.
   * @param {object} record Installation record.
   * @returns {string} Stable key for the record's drawn geometry.
   */
  function renderKey(record) {
    const footprints =
      record.footprints || (record.footprint ? [[record.footprint]] : []);
    const outlines =
      record.outlineLines || (record.footprint ? [record.footprint] : []);
    let points = 0;
    for (const rings of footprints)
      for (const ring of rings) points += ring.length;
    for (const line of outlines) points += line.length;
    return [
      record.latitude.toFixed(6),
      record.longitude.toFixed(6),
      record.class,
      record.kind,
      record.name,
      footprints.length,
      outlines.length,
      points,
    ].join('|');
  }

  function removeRecordEntities(id) {
    const entities = layerState.dataSource.entities;
    for (const entityId of layerState.renderedKeys.get(id)?.entityIds || [])
      entities.removeById(entityId);
    layerState.renderedKeys.delete(id);
  }

  /**
   * The records that get entities this paint: the nearest `MAX_RENDERED`, plus
   * the selected one when it falls outside that window.
   *
   * Context navigation walks the FULL nearby cohort, which is not bounded by the
   * render cap, so selecting item 701+ used to produce no entity at all — the
   * camera flew, `getById` returned null, and the selection was silently dropped
   * on the floor, leaving the Context subject stale so NEXT offered the same
   * installation forever. One extra entity keeps every cohort item selectable
   * and the cohort count honest.
   * @returns {Array<object>} Records to render this paint.
   */

  function renderableRecords() {
    const rendered = layerState.records
      .filter((r) => !r.pointOnly)
      .slice(0, MAX_RENDERED);
    if (!layerState.selectedId) return rendered;
    if (rendered.some((record) => record.id === layerState.selectedId))
      return rendered;
    const selected = layerState.recordById.get(layerState.selectedId);
    return selected ? [...rendered, selected] : rendered;
  }

  function renderRecords({ claimSelection = false } = {}) {
    // Context navigation can select another layer without a canvas click.
    // A delayed floor/data repaint must not steal that newer selection back.
    const selectedContext = getSelectedEntityContext();
    if (
      !claimSelection &&
      layerState.selectedId &&
      (!selectedContext || selectedContext.id !== layerState.selectedId)
    ) {
      layerState.selectedId = null;
    }
    let migratedSelection = false;
    if (
      layerState.selectedId &&
      !layerState.recordById.has(layerState.selectedId)
    ) {
      const replacement = layerState.records.find((record) =>
        record.aliasIds?.includes(layerState.selectedId),
      );
      if (replacement) {
        layerState.selectedId = replacement.id;
        migratedSelection = true;
      }
    }
    // Post-moveEnd debounced fetches commit after the camera settles; the
    // rebuilt entities need one frame in idle mode. (perf wave 2 fix)
    governorRequestRender('installations-render');
    if (
      layerState.records.some((r) =>
        r.sources?.some((s) => s.name === 'OpenStreetMap'),
      )
    )
      services.credits?.showOsmCredit?.(layerState.viewer, LAYER_ID, {
        openMapTiles: layerState.records.some((r) =>
          r.sources?.some(
            (s) => s.name === 'OpenStreetMap' && s.id?.startsWith('tile:'),
          ),
        ),
      });
    else services.credits?.hideOsmCredit?.(layerState.viewer, LAYER_ID);
    const records = renderableRecords();
    const keys = new Map(
      records.map((record) => [record.id, renderKey(record)]),
    );
    const entities = layerState.dataSource.entities;
    entities.suspendEvents();
    for (const [id, rendered] of [...layerState.renderedKeys])
      if (keys.get(id) !== rendered.key) removeRecordEntities(id);
    for (const record of records) {
      const color = parts.model.colorFor(record);
      const surfaceHeightM = installationSurfaceHeightM(record);
      const displayPosition = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        surfaceHeightM,
      );
      const selectedRecord = record.id === layerState.selectedId;
      const retained = layerState.renderedKeys.has(record.id)
        ? entities.getById(record.id)
        : null;
      if (retained) {
        // Same geometry: update the marker in place (selection, floor height).
        if (retained.gevInstallationHeightM !== surfaceHeightM) {
          retained.gevInstallationHeightM = surfaceHeightM;
          retained.position = displayPosition;
          retained.gevDisplayPosition = () => displayPosition;
        }
        if (retained.gevInstallationSelected !== selectedRecord) {
          retained.gevInstallationSelected = selectedRecord;
          retained.point.pixelSize = selectedRecord ? 13 : 9;
          retained.point.color = selectedRecord ? Cesium.Color.WHITE : color;
        }
        continue;
      }
      const entityIds = [record.id];
      layerState.renderedKeys.set(record.id, {
        key: keys.get(record.id),
        entityIds,
      });
      const entity = layerState.dataSource.entities.add({
        id: record.id,
        position: displayPosition,
        point: {
          show: !record.namedArea,
          pixelSize: record.id === layerState.selectedId ? 13 : 9,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          color:
            record.id === layerState.selectedId ? Cesium.Color.WHITE : color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      const outlines =
        record.outlineLines || (record.footprint ? [record.footprint] : []);
      for (let i = 0; i < outlines.length; i++) {
        const outline = layerState.dataSource.entities.add({
          id: `${record.id}:outline:${i}`,
          polyline: {
            positions: outlines[i].map(([lon, lat]) =>
              Cesium.Cartesian3.fromDegrees(lon, lat),
            ),
            width: 2,
            material: color.withAlpha(0.85),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
        outline.installationId = record.id;
        entityIds.push(outline.id);
      }
      entity.gevInstallationHeightM = surfaceHeightM;
      entity.gevInstallationSelected = selectedRecord;
      entity.gevTrackedId = `installations:${record.id}`;
      entity.gevDisplayPosition = () => displayPosition;
      entity.gevLabelModel = {
        title: record.name || t('layers.installations.fallbackTitle'),
        details: [
          String(record.class || 'installation')
            .replaceAll('_', ' ')
            .toUpperCase(),
          ...(record.memberNames || []).slice(0, 3),
        ],
        accent: COLOR_BY_CLASS[record.class] || '#9ca6b0',
      };
      registerEntityContext(entity, {
        id: record.id,
        layerId: LAYER_ID,
        layerName:
          record.kind === 'place_candidate'
            ? 'Military Site Search Candidates'
            : 'Mapped Military Installations',
        source: parts.model.installationSourceLabel(record),
        label: record.name,
        latitude: record.latitude,
        longitude: record.longitude,
        properties: {
          class: record.class,
          memberNames: record.memberNames || [],
          primaryType: record.primaryType || null,
          placeTypes: Array.isArray(record.placeTypes) ? record.placeTypes : [],
          validation: record.validation,
          retrievedAt: record.retrievedAt,
        },
      });
    }
    entities.resumeEvents();
    const selectedEntity = layerState.selectedId
      ? layerState.dataSource.entities.getById(layerState.selectedId)
      : null;
    if (selectedEntity && (claimSelection || migratedSelection))
      selectEntityContext(selectedEntity);
    else if (!selectedEntity) layerState.selectedId = null;
    // Re-register rebuilt geometry and migrate aliases before pruning old context.
    removeEntityContextsForLayer(LAYER_ID, { retainIds: new Set(keys.keys()) });
    parts.namedMarkers?.sync(layerState.records);
    syncSelectionFill();
  }

  /**
   * Second paint for floors that missed the bounded pre-render deadline.
   *
   * `resolveGroundFloorCellsBounded` gives up after FLOOR_RESOLVE_DEADLINE_MS so
   * a cold DEM can never hold the dots hostage — but the resolve keeps running
   * and lands seconds later, and without this the records it covers stay pinned
   * at ellipsoid height 0, sitting visibly under the 3D tiles (owner playtest
   * 2026-08-18: "orange dots at the bottom").
   *
   * This is the render -> warm -> re-render chain FIRMS already uses, with one
   * difference the installations path forces: the trigger is whether a cell that
   * was COLD AT PAINT TIME is warm now, not whether this particular batch warmed
   * it. The bounded resolve above is still running against the same cells, so
   * asking "did MY batch warm anything" would answer false exactly when the other
   * resolve won the race — the common case. Still terminating: a set that is
   * wholly cold afterwards re-renders zero times and the next camera-driven load
   * retries.
   * @param {Array<object>} records Records just rendered.
   * @returns {void}
   */

  function warmInstallationFloors(records) {
    const cold = records
      .filter(
        (record) =>
          cachedGroundFloor(record.latitude, record.longitude) == null,
      )
      .map((record) => ({ lat: record.latitude, lon: record.longitude }));
    if (!cold.length) return;
    warmFireAnchorFloors(cold).then(() => {
      if (!layerState.enabled || !layerState.dataSource) return;
      if (
        !cold.some((point) => cachedGroundFloor(point.lat, point.lon) != null)
      )
        return;
      renderRecords();
    });
  }
  return {
    installationSurfaceHeightM,
    clearSelectionFill,
    syncSelectionFill,
    clearRendered,
    renderableRecords,
    renderRecords,
    warmInstallationFloors,
  };
}
