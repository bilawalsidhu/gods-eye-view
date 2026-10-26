import * as Cesium from 'cesium';
import { selectInfraLod } from '../../data/localGeojsonLod.js';
import { createInfrastructureOverlayEntry } from '../../data/infrastructureOverlayEntry.js';
import { t, msg } from '../../i18n/index.js';
import { OFFSHORE_LAYER_ID as ID } from './records.js';
import {
  BSEE_SOURCE_URL,
  OFFSHORE_COLORS,
  platformTitle,
  platformKind,
  platformDetails,
} from './presentation.js';

/** Bounded native pick targets and shared-host text, using only supplied app services. */
export async function createOffshoreRenderer(
  viewer,
  snapshot,
  services,
  { signal } = {},
) {
  const ds = new Cesium.CustomDataSource(ID);
  await viewer.dataSources.add(ds);
  if (signal?.aborted) {
    viewer.dataSources.remove(ds, true);
    return { destroy() {}, getDiagnostics: () => ({ active: 0 }) };
  }
  const { overlayHost } = services;
  const selectionSource = `${ID}-selection`;
  const points = snapshot.records.map((record) => ({
    record,
    position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, 10),
  }));
  const byId = new Map(points.map((point) => [point.record.id, point]));
  let destroyed = false;
  let dirty = true;
  let dimensions = '';
  let active = new Set();
  let budgetLimit = 0;
  let selected = null;
  let handler;
  const removers = [];
  const requestRender = () =>
    services.governorRequestRender(`offshore-platforms`);

  function showSelection(entity) {
    if (selected === entity) return;
    selected = entity?.__offshoreRecord ? entity : null;
    overlayHost.clearSource(selectionSource);
    if (!selected) return;
    const record = selected.__offshoreRecord;
    overlayHost.setEntries(
      selectionSource,
      [
        {
          ...createInfrastructureOverlayEntry({
            id: record.id,
            source: selectionSource,
            position: byId.get(record.id).position,
            title: platformTitle(record),
            details: platformDetails(record, snapshot.metadata),
            accent: OFFSHORE_COLORS[record.kind],
            priority: 10000,
          }),
          variant: 'selected',
          selected: true,
          protected: true,
          maxDistance: Infinity,
          distanceFadeStartRatio: 1,
          interactive: true,
          accessibilityLabel: t('Open BSEE platform inventory source'),
          activate: () => services.openSource(BSEE_SOURCE_URL),
        },
      ],
      { cohortLimit: 1, collisionCapacity: 1 },
    );
    overlayHost.setVisible(selectionSource, true);
    services.selectEntityContext(entity);
    requestRender();
  }

  function render() {
    if (destroyed) return;
    const canvas = viewer.scene.canvas;
    const size = `${canvas.clientWidth}:${canvas.clientHeight}`;
    if (!dirty && dimensions === size) return;
    dimensions = size;
    dirty = false;
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      viewer.camera.positionWC,
    );
    const candidates = points.map(({ record, position }) => {
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        position,
      );
      return {
        id: record.id,
        priority: 0,
        inView:
          occluder.isPointVisible(position) &&
          !!screen &&
          screen.x >= 0 &&
          screen.y >= 0 &&
          screen.x <= canvas.clientWidth &&
          screen.y <= canvas.clientHeight,
        distanceM: Cesium.Cartesian3.distance(
          position,
          viewer.camera.positionWC,
        ),
      };
    });
    const result = selectInfraLod(candidates, {
      cameraHeightM: viewer.camera.positionCartographic.height,
      incumbentIds: active,
    });
    active = new Set(result.activeIds);
    budgetLimit = result.budget.activeLimit;
    // Clear a selection that leaves the materialized cohort rather than retain a ghost target.
    if (selected && !active.has(selected.__offshoreRecord.id)) {
      viewer.selectedEntity = undefined;
      services.clearSelectedEntityContextForLayer(ID);
      showSelection(null);
    }
    services.removeEntityContextsForLayer(ID, {
      retainIds: new Set([...active].map((id) => `${ID}:${id}`)),
    });
    for (const entity of [...ds.entities.values]) {
      if (!active.has(entity.__offshoreRecord.id)) ds.entities.remove(entity);
    }
    const labels = [];
    for (const id of active) {
      const { record, position } = byId.get(id);
      let entity = ds.entities.getById(`${ID}:${id}`);
      if (!entity) {
        entity = ds.entities.add({
          id: `${ID}:${id}`,
          name: platformTitle(record),
          position,
          point: {
            pixelSize: record.kind === 'subsea' ? 7 : 9,
            color: Cesium.Color.fromCssColorString(
              OFFSHORE_COLORS[record.kind],
            ),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            disableDepthTestDistance: Infinity,
          },
        });
        entity.__offshoreRecord = record;
      }
      services.registerEntityContext(entity, {
        id: entity.id,
        layerId: ID,
        layerName: 'Offshore Oil & Gas Platforms',
        source: 'BSEE',
        label: platformTitle(record),
        latitude: record.lat,
        longitude: record.lon,
        properties: {
          ...record,
          ...snapshot.metadata,
          status: msg('No removal date recorded; production status unknown'),
          sourceUrl: BSEE_SOURCE_URL,
        },
      });
      if (labels.length < 80 && entity !== selected)
        labels.push(
          createInfrastructureOverlayEntry({
            id,
            source: ID,
            position,
            title: platformTitle(record),
            details: [platformKind(record)],
            accent: OFFSHORE_COLORS[record.kind],
            priority: 0,
          }),
        );
    }
    overlayHost.setEntries(ID, labels, {
      cohortLimit: 80,
      collisionCapacity: 40,
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const remove of removers) remove?.();
    handler?.destroy();
    if (viewer.selectedEntity?.__offshoreRecord)
      viewer.selectedEntity = undefined;
    services.clearSelectedEntityContextForLayer(ID);
    services.removeEntityContextsForLayer(ID);
    for (const source of [ID, selectionSource]) {
      overlayHost.clearSource(source);
      overlayHost.setVisible(source, false);
    }
    viewer.dataSources.remove(ds, true);
    requestRender();
  }
  try {
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(({ position }) => {
      if (!services.isPointerFree()) return;
      const entity = viewer.scene.pick(position)?.id;
      if (entity?.__offshoreRecord && ds.entities.contains(entity)) {
        viewer.selectedEntity = entity;
        showSelection(entity);
      } else {
        if (selected) services.clearSelectedEntityContextForLayer(ID);
        showSelection(null);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    removers.push(viewer.selectedEntityChanged.addEventListener(showSelection));
    removers.push(
      services.onSelectionChanged((record) => {
        if (record?.layerId !== ID) showSelection(null);
      }),
    );
    removers.push(
      viewer.camera.changed.addEventListener(() => {
        dirty = true;
      }),
    );
    removers.push(
      viewer.camera.moveEnd.addEventListener(() => {
        dirty = true;
      }),
    );
    removers.push(viewer.scene.preRender.addEventListener(render));
    overlayHost.setVisible(ID, true);
    requestRender();
  } catch (error) {
    destroy();
    throw error;
  }
  return {
    destroy,
    getDiagnostics: () => ({
      active: active.size,
      budgetLimit,
      total: points.length,
      materialized: ds.entities.values.length,
    }),
  };
}
