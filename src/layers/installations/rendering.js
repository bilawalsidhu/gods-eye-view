import { installationClassLabel, installationTitle } from './classLabel.js';
import { t } from '../../i18n/index.js';
import { LAYER_ID, MAX_RENDERED, COLOR_BY_CLASS } from './policy.js';
import { entityRecord } from '../../data/entityRecords.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findGlobe } from '../../render/rendererOf.js';

let instances = 0;

const DOT_OUTLINE = Object.freeze([0, 0, 0, 0.8]);
const SELECTED_DOT = Object.freeze([1, 1, 1, 1]);

/** A record's footprint polygons, each its rings of `[lon, lat]`. */
const footprintsOf = (record) =>
  record.footprints || (record.footprint ? [[record.footprint]] : []);

/** A record's outline polylines of `[lon, lat]`. */
const outlinesOf = (record) =>
  record.outlineLines || (record.footprint ? [record.footprint] : []);

/**
 * The installations layer's drawing: a draw-port point set of site dots, a
 * point set of the selected site's dot (so selecting one restyles no other
 * dot), a line set of their ground outlines and a shape set of the selected
 * site's footprint fill, on the viewer's renderer (`drawOf`).
 */
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

  /** A record's class colour with alpha `alpha`, as the draw port takes it. */
  function colorFor(record, alpha = null) {
    const [r, g, b, a] = parts.model.colorFor(record);
    return [r, g, b, alpha ?? a];
  }

  /** Make the layer's draw sets, hidden until the layer is enabled. */
  function attach(viewer) {
    const draw = drawOf(viewer);
    selectedDotKey = null;
    const prefix = `${LAYER_ID}:${++instances}`;
    layerState.sets = {
      dots: draw.points({ id: `${prefix}:dots`, show: false }),
      selected: draw.points({ id: `${prefix}:selected`, show: false }),
      outlines: draw.lines({ id: `${prefix}:outlines`, show: false }),
      fills: draw.shapes({ id: `${prefix}:fills`, show: false }),
    };
  }

  function detach() {
    if (layerState.sets)
      for (const set of Object.values(layerState.sets)) set.dispose();
    layerState.sets = null;
  }

  /** Show or hide everything the layer draws. */
  function setShown(shown) {
    if (!layerState.sets) return;
    for (const set of Object.values(layerState.sets)) set.show = shown;
  }

  /** Whether `setId` is one of this layer's sets. */
  function ownsSet(setId) {
    return Boolean(
      layerState.sets &&
      Object.values(layerState.sets).some((set) => set.id === setId),
    );
  }

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
    if (selectedFillIds.length) layerState.sets?.fills.remove(selectedFillIds);
    selectedFillIds.length = 0;
    selectedFillKey = null;
  }

  /** Ground geometry classifies the active surface; no height/extrusion plane. */
  function syncSelectionFill() {
    const record =
      layerState.enabled &&
      layerState.sets &&
      layerState.recordById.get(layerState.selectedId);
    if (!record) {
      clearSelectionFill();
      return;
    }
    // Tiles alone while the globe surface is hidden, as under photoreal.
    const clampTo =
      findGlobe(layerState.viewer)?.isGlobeVisible?.() === false
        ? 'tiles'
        : 'both';
    const key = `${record.id}|${renderKey(record)}|${clampTo}`;
    if (key === selectedFillKey) return;
    clearSelectionFill();
    selectedFillKey = key;
    const fill = colorFor(record, 0.22);
    const meta = { installationId: record.id };
    const items = footprintsOf(record).map((rings, i) => ({
      id: `${record.id}:selected-fill:${i}`,
      geometry: {
        kind: 'polygon',
        rings: rings.map((ring) => ring.map(([lon, lat]) => ({ lon, lat }))),
      },
      fill,
      height: 'clampGround',
      clampTo,
      meta,
    }));
    if (items.length) layerState.sets.fills.upsert(items);
    for (const item of items) selectedFillIds.push(item.id);
    governorRequestRender('installation-selection-fill');
  }

  function clearRendered() {
    clearSelectionFill();
    if (layerState.sets) {
      layerState.sets.dots.clear();
      layerState.sets.selected.clear();
      layerState.sets.outlines.clear();
    }
    selectedDotKey = null;
    layerState.renderedKeys.clear();
    removeEntityContextsForLayer(LAYER_ID);
  }

  /**
   * Geometry identity of one rendered record. Records whose key is unchanged
   * keep their drawn items across refreshes, only restyled or moved in
   * place, so an unchanged site never blinks.
   * @param {object} record Installation record.
   * @returns {string} Stable key for the record's drawn geometry.
   */
  function renderKey(record) {
    const footprints = footprintsOf(record);
    const outlines = outlinesOf(record);
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

  /**
   * A site's dot. The selected site's is hidden here and drawn larger, in
   * white, by the selected set (`selectedDotItem`): a clamped dot is
   * restyled only by drawing it again, so its own set never changes look.
   */
  function dotItem(record, rendered) {
    return {
      id: record.id,
      pos: {
        lon: record.longitude,
        lat: record.latitude,
        height: rendered.heightM,
      },
      height: 'clampGround',
      show: !record.namedArea && !rendered.selected,
      pixelSize: 9,
      color: colorFor(record),
      outlineColor: DOT_OUTLINE,
      outlineWidth: 1,
      disableDepthTest: Number.POSITIVE_INFINITY,
      meta: rendered.carrier,
    };
  }

  /** The selected site's dot, as its own set draws it. */
  function selectedDotItem(record, rendered) {
    return {
      ...dotItem(record, rendered),
      show: true,
      pixelSize: 13,
      color: SELECTED_DOT,
    };
  }

  /** What the selected set draws now (site, place, height), or null. */
  let selectedDotKey = null;

  /** Draw the selected site's dot, when it has one shown. */
  function syncSelectedDot() {
    const sets = layerState.sets;
    if (!sets) return;
    const rendered = layerState.selectedId
      ? layerState.renderedKeys.get(layerState.selectedId)
      : null;
    const record = rendered
      ? layerState.recordById.get(layerState.selectedId)
      : null;
    const key =
      record && rendered.selected && !record.namedArea
        ? [record.id, record.longitude, record.latitude, rendered.heightM].join(
            '|',
          )
        : null;
    if (key === selectedDotKey) return;
    selectedDotKey = key;
    if (key) sets.selected.set([selectedDotItem(record, rendered)]);
    else sets.selected.clear();
  }

  /** Stop drawing a record's dot and outlines. */
  function removeRecordItems(id, dotIds, outlineIds) {
    const rendered = layerState.renderedKeys.get(id);
    if (!rendered) return;
    dotIds.push(id);
    outlineIds.push(...rendered.outlineIds);
    layerState.renderedKeys.delete(id);
  }

  /**
   * The records that get drawn this paint: the nearest `MAX_RENDERED`, plus
   * the selected one when it falls outside that window.
   *
   * Context navigation walks the FULL nearby cohort, which is not bounded by the
   * render cap, so selecting item 701+ used to produce no marker at all — the
   * camera flew, the lookup returned null, and the selection was silently dropped
   * on the floor, leaving the Context subject stale so NEXT offered the same
   * installation forever. One extra marker keeps every cohort item selectable
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
    // rebuilt markers need one frame in idle mode. (perf wave 2 fix)
    governorRequestRender('installations-render');
    const records = renderableRecords();
    const keys = new Map(
      records.map((record) => [record.id, renderKey(record)]),
    );
    const removedDots = [];
    const removedOutlines = [];
    for (const [id, rendered] of [...layerState.renderedKeys])
      if (keys.get(id) !== rendered.key)
        removeRecordItems(id, removedDots, removedOutlines);
    const dots = [];
    const outlines = [];
    for (const record of records) {
      const surfaceHeightM = installationSurfaceHeightM(record);
      const selectedRecord = record.id === layerState.selectedId;
      const retained = layerState.renderedKeys.get(record.id);
      if (retained) {
        // Same geometry: update the marker in place (selection, floor height).
        let changed = false;
        if (retained.heightM !== surfaceHeightM) {
          retained.heightM = surfaceHeightM;
          const displayPosition = fromDegrees(
            record.longitude,
            record.latitude,
            surfaceHeightM,
          );
          entityRecord(retained.carrier).displayPosition = () =>
            displayPosition;
          changed = true;
        }
        if (retained.selected !== selectedRecord) {
          retained.selected = selectedRecord;
          changed = true;
        }
        if (changed) dots.push(dotItem(record, retained));
        continue;
      }
      const displayPosition = fromDegrees(
        record.longitude,
        record.latitude,
        surfaceHeightM,
      );
      // What the dot's pick carries and the shared selection, the tracked
      // card and a follow read this site through.
      const carrier = { id: record.id, installationId: record.id };
      const rendered = {
        key: keys.get(record.id),
        outlineIds: [],
        carrier,
        heightM: surfaceHeightM,
        selected: selectedRecord,
      };
      layerState.renderedKeys.set(record.id, rendered);
      dots.push(dotItem(record, rendered));
      const outlineColor = colorFor(record, 0.85);
      const outlineMeta = { installationId: record.id };
      const lines = outlinesOf(record);
      for (let i = 0; i < lines.length; i++) {
        const id = `${record.id}:outline:${i}`;
        outlines.push({
          id,
          positions: lines[i].map(([lon, lat]) => fromDegrees(lon, lat)),
          widthPx: 2,
          mode: 'draped',
          clampTo: 'both',
          style: { kind: 'solid', color: outlineColor },
          meta: outlineMeta,
        });
        rendered.outlineIds.push(id);
      }
      entityRecord(carrier).trackedId = `installations:${record.id}`;
      entityRecord(carrier).displayPosition = () => displayPosition;
      entityRecord(carrier).labelModel = {
        title: installationTitle(record.name) || t('MAPPED INSTALLATION'),
        details: [
          installationClassLabel(record.class),
          ...(record.memberNames || []).slice(0, 3),
        ],
        accent: COLOR_BY_CLASS[record.class] || '#9ca6b0',
      };
      registerEntityContext(carrier, {
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
    const sets = layerState.sets;
    if (removedDots.length) sets.dots.remove(removedDots);
    if (removedOutlines.length) sets.outlines.remove(removedOutlines);
    if (dots.length) sets.dots.upsert(dots);
    if (outlines.length) sets.outlines.upsert(outlines);
    syncSelectedDot();
    const selected = layerState.selectedId
      ? layerState.renderedKeys.get(layerState.selectedId)
      : null;
    if (selected && (claimSelection || migratedSelection))
      selectEntityContext(selected.carrier);
    else if (!selected) layerState.selectedId = null;
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
      if (!layerState.enabled || !layerState.sets) return;
      if (
        !cold.some((point) => cachedGroundFloor(point.lat, point.lon) != null)
      )
        return;
      renderRecords();
    });
  }
  return {
    attach,
    detach,
    setShown,
    ownsSet,
    installationSurfaceHeightM,
    clearSelectionFill,
    syncSelectionFill,
    clearRendered,
    renderableRecords,
    renderRecords,
    warmInstallationFloors,
  };
}
