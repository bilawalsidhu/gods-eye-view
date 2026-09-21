import * as Cesium from 'cesium';
import { cardBodyLines } from './measurements.js';
import {
  COLOR_BY_FAMILY,
  DEFAULT_COLOR,
  LABEL_FALLOFF,
  LABEL_VISIBLE_DISTANCE_M,
  LAYER_ID,
  MARKER_FALLOFF,
  MARKER_PIXEL_SIZE,
  MARKER_SELECTED_PIXEL_SIZE,
  MAX_CARD_MEASUREMENTS,
  MAX_RENDERED,
} from './policy.js';

/**
 * Shared falloff curves, built once: Cesium reads these every frame, so a fresh
 * scalar per entity per paint would allocate hundreds of short-lived objects on
 * a layer that repaints on every camera settle.
 */
const MARKER_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  MARKER_FALLOFF.nearM,
  MARKER_FALLOFF.nearScale,
  MARKER_FALLOFF.farM,
  MARKER_FALLOFF.farScale,
);
const LABEL_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  LABEL_FALLOFF.nearM,
  LABEL_FALLOFF.nearScale,
  LABEL_FALLOFF.farM,
  LABEL_FALLOFF.farScale,
);
const LABEL_DISPLAY_CONDITION = new Cesium.DistanceDisplayCondition(
  0,
  LABEL_VISIBLE_DISTANCE_M,
);
/** Matches the application's glass panel surface (see foundation.css). */
const CARD_BACKGROUND = Cesium.Color.fromCssColorString(
  'rgba(12, 12, 20, 0.88)',
);
const CARD_PADDING = new Cesium.Cartesian2(10, 8);
const LABEL_TRANSLUCENCY_BY_DISTANCE = new Cesium.NearFarScalar(
  LABEL_VISIBLE_DISTANCE_M * 0.6,
  1,
  LABEL_VISIBLE_DISTANCE_M,
  0,
);

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
   * Shared rendered-surface height for a monitoring site.
   * @param {{latitude:number, longitude:number}} record Site record.
   * @returns {number} Ellipsoidal render height in metres.
   */

  function siteSurfaceHeightM(record) {
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
   * the selected one when it falls outside that window. Context navigation walks
   * the full cohort, so without the extra entity an item past the cap would fly
   * the camera and then resolve to nothing, stranding the shared subject.
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

  /**
   * Card detail lines for a site.
   *
   * States what was measured and when, and never converts a concentration into
   * a verdict: thresholds differ per analyte and medium, and this layer has no
   * standing to declare water safe or unsafe.
   * @param {object} record Site record.
   * @returns {Array<string>} Detail lines.
   */

  function detailLines(record) {
    const measurements = layerState.measurementsBySite.get(record.id);
    if (!measurements)
      return [
        layerState.measurementsLoading
          ? 'Loading measurements…'
          : layerState.measurementsError || 'Click to load measurements',
      ];
    const lines = cardBodyLines(measurements, MAX_CARD_MEASUREMENTS);
    const latest = parts.model.latestSampleDate(measurements);
    if (latest) lines.push(`Sampled ${latest}`);
    return lines;
  }

  /**
   * Label text for one site.
   *
   * The measurements ride the entity's own label rather than only
   * `gevLabelModel`: that model is read by the tracked/detection overlay, which
   * is not showing for an ordinary selected point, so a click loaded the values
   * and then had nowhere to put them. The label is the surface the operator is
   * already looking at.
   * @param {object} record Site record.
   * @param {boolean} selected Whether this record owns the selection.
   * @returns {string} Rendered label text.
   */

  function labelTextFor(record, selected) {
    const title = record.name || 'MONITORING SITE';
    if (!selected) return title;
    const body = detailLines(record);
    // A rule under the title separates identity from measurement, and its width
    // is the table's own width so the block reads as one card.
    const width = Math.max(title.length, ...body.map((line) => line.length));
    return [title, '─'.repeat(width), ...body].join('\n');
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
    governorRequestRender('water-quality-render');
    clearRendered();
    for (const record of renderableRecords()) {
      const color = parts.model.colorFor(record);
      const surfaceHeightM = siteSurfaceHeightM(record);
      const displayPosition = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        surfaceHeightM,
      );
      const selected = record.id === layerState.selectedId;
      const entity = layerState.dataSource.entities.add({
        id: record.id,
        position: displayPosition,
        point: {
          pixelSize: selected ? MARKER_SELECTED_PIXEL_SIZE : MARKER_PIXEL_SIZE,
          color: selected ? Cesium.Color.WHITE : color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // Recede with the camera, but never below a readable dot and never
          // faded: pulling back is how the shape of the network is read, and a
          // view where only the selected site survives is worse than no falloff.
          scaleByDistance: MARKER_SCALE_BY_DISTANCE,
        },
        // Monitoring coverage is sparse — a viewport often holds a handful of
        // sites rather than a cluster — so an unlabelled dot is unidentifiable
        // without clicking it. Label near the ground and drop the text (not the
        // marker) once the camera pulls back far enough for them to collide.
        label: {
          text: labelTextFor(record, selected),
          font: '11px "JetBrains Mono", "SF Mono", monospace',
          fillColor: selected ? Cesium.Color.WHITE : color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          // A selected site is a table, and Cesium centres label text by
          // default, which ragged-centres every row and destroys the value
          // column. The card hangs left-aligned beside its marker; a lone name
          // still reads best centred above its dot.
          horizontalOrigin: selected
            ? Cesium.HorizontalOrigin.LEFT
            : Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: selected
            ? Cesium.VerticalOrigin.CENTER
            : Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: selected
            ? new Cesium.Cartesian2(14, 0)
            : new Cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // A dense table drawn straight onto imagery competes with every
          // neighbouring site name underneath it. Back the selected card with
          // the panel colour so it reads as a card rather than as loose text.
          showBackground: selected,
          backgroundColor: CARD_BACKGROUND,
          backgroundPadding: CARD_PADDING,
          // The selected site is exempt from the distance gate and the scale
          // falloff: it is the one the operator asked to read, so it stays
          // legible from wherever they clicked it.
          scaleByDistance: selected ? undefined : LABEL_SCALE_BY_DISTANCE,
          distanceDisplayCondition: selected
            ? undefined
            : LABEL_DISPLAY_CONDITION,
          translucencyByDistance: selected
            ? undefined
            : LABEL_TRANSLUCENCY_BY_DISTANCE,
        },
      });
      entity.gevTrackedId = `water-quality:${record.id}`;
      entity.gevDisplayPosition = () => displayPosition;
      entity.gevLabelModel = {
        title: record.name || 'MONITORING SITE',
        details: detailLines(record),
        accent: COLOR_BY_FAMILY[record.family] || DEFAULT_COLOR,
      };
      registerEntityContext(entity, {
        id: record.id,
        layerId: LAYER_ID,
        layerName: 'Water Quality Monitoring',
        source: parts.model.waterQualitySourceLabel(record),
        label: record.name,
        latitude: record.latitude,
        longitude: record.longitude,
        properties: {
          family: record.family,
          locationType: record.locationType,
          organization: record.organization,
          resultCount: record.resultCount,
          sampledSince: layerState.sampledSince,
          siteUrl: record.siteUrl,
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
   * The trigger is whether a cell that was COLD AT PAINT TIME is warm now, not
   * whether this particular batch warmed it: the bounded resolve is still
   * running against the same cells, so asking "did MY batch warm anything" would
   * answer false exactly when the other resolve won the race. Still terminating:
   * a wholly cold set re-renders zero times and the next camera load retries.
   * @param {Array<object>} records Records just rendered.
   * @returns {void}
   */

  function warmSiteFloors(records) {
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
    siteSurfaceHeightM,
    clearRendered,
    renderableRecords,
    renderRecords,
    warmSiteFloors,
  };
}
