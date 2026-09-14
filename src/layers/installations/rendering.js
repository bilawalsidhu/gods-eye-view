import * as Cesium from 'cesium';
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

  function clearRendered() {
    if (layerState.dataSource?.entities)
      layerState.dataSource.entities.removeAll();
    removeEntityContextsForLayer(LAYER_ID);
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
    const rendered = layerState.records.slice(0, MAX_RENDERED);
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
      selectedContext &&
      selectedContext.id !== layerState.selectedId
    ) {
      layerState.selectedId = null;
    }
    // Post-moveEnd debounced fetches commit after the camera settles; the
    // rebuilt entities need one frame in idle mode. (perf wave 2 fix)
    governorRequestRender('installations-render');
    clearRendered();
    for (const record of renderableRecords()) {
      const color = parts.model.colorFor(record);
      const surfaceHeightM = installationSurfaceHeightM(record);
      const displayPosition = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        surfaceHeightM,
      );
      const entity = layerState.dataSource.entities.add({
        id: record.id,
        position: displayPosition,
        point: {
          pixelSize: record.id === layerState.selectedId ? 13 : 9,
          color:
            record.id === layerState.selectedId ? Cesium.Color.WHITE : color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        polygon: record.footprint
          ? {
              hierarchy: new Cesium.PolygonHierarchy(
                record.footprint.map(([longitude, latitude]) =>
                  Cesium.Cartesian3.fromDegrees(longitude, latitude),
                ),
              ),
              material: color.withAlpha(0.12),
              outline: true,
              outlineColor: color.withAlpha(0.65),
              height: surfaceHeightM,
            }
          : undefined,
      });
      entity.gevTrackedId = `installations:${record.id}`;
      entity.gevDisplayPosition = () => displayPosition;
      entity.gevLabelModel = {
        title: record.name || 'MAPPED INSTALLATION',
        details: [
          String(record.class || 'installation')
            .replaceAll('_', ' ')
            .toUpperCase(),
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
          primaryType: record.primaryType || null,
          placeTypes: Array.isArray(record.placeTypes) ? record.placeTypes : [],
          validation: record.validation,
          retrievedAt: record.retrievedAt,
        },
      });
    }
    const selectedEntity = layerState.selectedId
      ? layerState.dataSource.entities.getById(layerState.selectedId)
      : null;
    if (selectedEntity) selectEntityContext(selectedEntity);
    else layerState.selectedId = null;
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
    clearRendered,
    renderableRecords,
    renderRecords,
    warmInstallationFloors,
  };
}
