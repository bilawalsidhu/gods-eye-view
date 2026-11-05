import { t } from '../../../i18n/index.js';
import * as geo from '../../../geo/index.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { createInfrastructureOverlayEntry } from '../../../data/infrastructureOverlayEntry.js';
import {
  MILITARY_LABEL_CAP,
  MILITARY_POINT_CAP,
} from '../../../data/militaryNames.js';
import { installationClassLabel, installationTitle } from '../classLabel.js';
import { COLOR_BY_CLASS, LAYER_ID, MAX_RENDERED } from '../policy.js';
import {
  createInstallationDrapedMesh,
  createInstallationOutlineDrapedMesh,
} from './navaraGeometry.js';
import { batchInstallationOutlines } from './navaraOutlineBatch.js';
import { defineGroundEffect } from '../../shared/render/navaraGroundEffect.js';

const KEY = 'gevInstallationsDrape';
const BLACK = [0, 0, 0, 0.8];
const IDLE_SHADER = /* glsl */ `
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
}
`;

const drapeEffect = defineGroundEffect({
  key: KEY,
  name: 'GevInstallationDrape',
  fragmentShader: IDLE_SHADER,
  insertAfter: ['mrt'],
  update() {
    const mrt = this.find('mrt');
    this.owner.globeNormal.value = mrt?.globeNormalBuffer ?? null;
    this.owner.globeDepth.value = mrt?.globeDepthBuffer ?? null;
    const scene = this.ctx.scenes.draped;
    this.owner.scene = scene;
    for (const mesh of this.owner.meshes)
      if (mesh.parent !== scene) scene.add(mesh);
  },
  destroy() {
    for (const mesh of this.owner.meshes) {
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.owner.meshes.clear();
    this.owner.scene = null;
  },
});

function createPointSet(engine, { id, sizePx, capacity, order }) {
  return engine.movers.createSet({
    id,
    kind: 'point',
    capacity,
    order,
    depthTest: 'normal',
    pickable: true,
    point: { sizePx, outlinePx: 1, outlineColor: BLACK },
  });
}

export function createInstallationsNavaraRenderer(
  engine,
  {
    state,
    services,
    parts,
    source,
    overlayHost,
    view,
    EffectDesc,
    NavaraEffect,
    DrapedMesh,
    setupMaterialForDrape,
  },
) {
  drapeEffect.register(view, { EffectDesc, NavaraEffect });

  const layerState = state;
  const owner = {
    meshes: new Set(),
    scene: null,
    globeNormal: { value: null },
    globeDepth: { value: null },
  };
  const normalSet = createPointSet(engine, {
    id: `${LAYER_ID}-normal`,
    sizePx: 9,
    capacity: MAX_RENDERED + 1,
    order: 10,
  });
  const selectedSet = createPointSet(engine, {
    id: `${LAYER_ID}-selected`,
    sizePx: 13,
    capacity: 1,
    order: 11,
  });
  const namedSet = createPointSet(engine, {
    id: `${LAYER_ID}-named`,
    sizePx: 7,
    capacity: MILITARY_POINT_CAP,
    order: 9,
  });
  const contextObjects = new Map();
  const namedRecords = new Map();
  const selectionMeshes = new Set();
  const outlineMeshes = new Set();
  let outlineRecords = [],
    outlineWidthM = null;
  let drapeHandle = null;
  let visible = false;
  let fillRecord = null;
  let interactionRemove = null;
  let removeContextListeners = null;
  let destroyed = false;

  const displayPosition = (record) =>
    geo.cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      parts.model.installationSurfaceHeightM(record),
    );
  const rgba = (record, selected = false) => {
    const color = parts.model.colorFor(record);
    return selected
      ? [1, 1, 1, 1]
      : [color.red, color.green, color.blue, color.alpha];
  };
  const schedule = () => engine.render.request('installations-render');

  function syncPlacesCredit(records) {
    const usesPlaces = records.some((record) =>
      record.sources?.some((item) => item.name === 'Google Maps Places'),
    );
    if (usesPlaces)
      services.credits?.showGooglePlacesCredit?.(engine, LAYER_ID);
    else services.credits?.hideGooglePlacesCredit?.(engine, LAYER_ID);
  }

  function replaceOwnedMeshes(previous, next) {
    for (const mesh of previous) {
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      owner.meshes.delete(mesh);
    }
    previous.clear();
    for (const mesh of next) {
      previous.add(mesh);
      owner.meshes.add(mesh);
    }
    syncDrapeEffect();
  }

  function setMeshList(next) {
    replaceOwnedMeshes(selectionMeshes, next);
  }

  function syncDrapeEffect() {
    const show = visible && owner.meshes.size > 0;
    if (show && !drapeHandle)
      drapeHandle = view.addEffect({ [KEY]: { owner }, visible: true });
    else if (drapeHandle) drapeHandle.update({ visible: show });
  }

  function fillMeshes(record) {
    const footprints =
      record.footprints || (record.footprint ? [[record.footprint]] : []);
    const color = parts.model.colorFor(record).toCssColorString();
    const meshes = [];
    for (const rings of footprints) {
      const mesh = createInstallationDrapedMesh(record, rings, {
        color,
        opacity: 0.22,
        globeNormal: owner.globeNormal,
        globeDepth: owner.globeDepth,
        DrapedMesh,
        setupMaterialForDrape,
      });
      if (mesh) meshes.push(mesh);
    }
    return meshes;
  }

  function clearSelectionFill() {
    fillRecord = null;
    setMeshList([]);
  }

  function syncSelectionFill() {
    const record =
      layerState.enabled && layerState.recordById.get(layerState.selectedId);
    if (record === fillRecord) return;
    fillRecord = record ?? null;
    setMeshList(record ? fillMeshes(record) : []);
  }

  function syncOutlines(records) {
    const canvasHeight = Math.max(1, view.canvas?.clientHeight || 1);
    const cameraHeight = Math.max(0, engine.camera.height?.() || 0);
    const fov = ((view.camera?.raw?.fov || 60) * Math.PI) / 180;
    const widthM = Math.max(
      1,
      (2 * cameraHeight * Math.tan(fov / 2) * 2) / canvasHeight,
    );
    const desired = records.filter(
      (record) => !record.pointOnly && !record.namedArea,
    );
    if (
      outlineWidthM === widthM &&
      desired.length === outlineRecords.length &&
      desired.every((record, index) => record === outlineRecords[index])
    )
      return;
    const next = [];
    for (const record of desired) {
      const lines =
        record.outlineLines || (record.footprint ? [record.footprint] : []);
      const meshes = lines
        .map((line) =>
          createInstallationOutlineDrapedMesh(record, line, {
            color: parts.model.colorFor(record).toCssColorString(),
            widthM,
            globeNormal: owner.globeNormal,
            globeDepth: owner.globeDepth,
            DrapedMesh,
            setupMaterialForDrape,
          }),
        )
        .filter(Boolean);
      next.push(...meshes);
    }
    replaceOwnedMeshes(outlineMeshes, batchInstallationOutlines(next));
    outlineRecords = desired;
    outlineWidthM = widthM;
  }

  function clearOutlines() {
    replaceOwnedMeshes(outlineMeshes, []);
    outlineRecords = [];
    outlineWidthM = null;
  }

  function registerContext(record) {
    let context = contextObjects.get(record.id);
    if (!context) {
      context = {};
      contextObjects.set(record.id, context);
    }
    context.gevContextId = record.id;
    context.gevLabelModel = {
      title: installationTitle(record.name) || t('MAPPED INSTALLATION'),
      details: [
        installationClassLabel(record.class),
        ...(record.memberNames || []).slice(0, 3),
      ],
      accent: COLOR_BY_CLASS[record.class] || '#9ca6b0',
    };
    services.context.registerEntityContext(context, {
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
    return context;
  }

  function renderRecords({ claimSelection = false } = {}) {
    if (destroyed) return;
    const selectedContext = services.context.getSelectedEntityContext();
    if (
      !claimSelection &&
      layerState.selectedId &&
      selectedContext?.id !== layerState.selectedId
    )
      layerState.selectedId = null;
    if (
      layerState.selectedId &&
      !layerState.recordById.has(layerState.selectedId)
    ) {
      const replacement = layerState.records.find((record) =>
        record.aliasIds?.includes(layerState.selectedId),
      );
      layerState.selectedId = replacement?.id ?? null;
    }

    const records = layerState.records.filter(
      (record) => !record.pointOnly && !record.namedArea,
    );
    const hasOsm = layerState.records.some((record) =>
      record.sources?.some((item) => item.name === 'OpenStreetMap'),
    );
    if (hasOsm)
      services.credits?.showOsmCredit?.(engine, LAYER_ID, {
        openMapTiles: layerState.records.some((record) =>
          record.sources?.some(
            (item) =>
              item.name === 'OpenStreetMap' && item.id?.startsWith('tile:'),
          ),
        ),
      });
    else services.credits?.hideOsmCredit?.(engine, LAYER_ID);
    syncPlacesCredit(layerState.records);
    const normal = records
      .filter((record) => record.id !== layerState.selectedId)
      .slice(0, MAX_RENDERED);
    const selected = layerState.records.find(
      (record) => record.id === layerState.selectedId && !record.pointOnly,
    );
    normalSet.setCount(normal.length);
    for (let index = 0; index < normal.length; index++) {
      const record = normal[index];
      normalSet.set(index, {
        position: displayPosition(record),
        color: rgba(record),
        pickId: record.id,
      });
    }
    selectedSet.setCount(selected ? 1 : 0);
    if (selected)
      selectedSet.set(0, {
        position: displayPosition(selected),
        color: rgba(selected, true),
        pickId: selected.id,
      });
    normalSet.commit();
    selectedSet.commit();

    const retainIds = new Set(
      [...normal, ...(selected ? [selected] : [])].map((r) => r.id),
    );
    for (const record of [...normal, ...(selected ? [selected] : [])]) {
      const entity = registerContext(record);
      if (
        record.id === layerState.selectedId &&
        (claimSelection || !selectedContext)
      )
        services.context.selectEntityContext(entity);
    }
    services.context.removeEntityContextsForLayer(LAYER_ID, { retainIds });
    parts.namedMarkers.sync(layerState.records);
    syncOutlines([...normal, ...(selected ? [selected] : [])]);
    syncSelectionFill();
    schedule();
  }

  function selectRecord(id) {
    if (!layerState.recordById.has(id)) return false;
    layerState.selectedId = id;
    renderRecords({ claimSelection: true });
    return true;
  }

  function deselect() {
    if (!layerState.selectedId) return;
    layerState.selectedId = null;
    services.context.clearSelectedEntityContextForLayer(LAYER_ID);
    renderRecords();
  }

  const namedMarkers = {
    enable() {
      namedSet.setCount(namedRecords.size);
      overlayHost.setVisible(LAYER_ID, true);
    },
    hide() {
      namedSet.setCount(0);
      namedSet.commit();
      overlayHost.clearSource(LAYER_ID);
      overlayHost.setVisible(LAYER_ID, false);
    },
    sync(records) {
      namedRecords.clear();
      const named = records
        .filter((record) => record.namedArea || record.pointOnly)
        .sort((a, b) => b.areaM2 - a.areaM2)
        .slice(0, MILITARY_POINT_CAP);
      const entries = [];
      for (let index = 0; index < named.length; index++) {
        const record = named[index];
        namedRecords.set(record.id, record);
        const position = geo.cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          record.pointOnly ? 0 : parts.model.installationSurfaceHeightM(record),
        );
        namedSet.set(index, {
          position,
          color: rgba(record),
          pickId: record.id,
        });
        const entry = createInfrastructureOverlayEntry({
          id: record.id,
          source: LAYER_ID,
          position,
          title: record.name,
          priority: record.areaM2 || 0,
          accent: COLOR_BY_CLASS[record.class] || '#9ca6b0',
        });
        const selected = record.id === layerState.selectedId;
        entry.variant = selected ? 'selected' : 'card';
        entry.selected = selected;
        entry.details = selected
          ? [
              String(record.class || 'installation')
                .replaceAll('_', ' ')
                .toUpperCase(),
              ...(record.memberNames || []).slice(0, 3),
            ]
          : [];
        entries.push(entry);
      }
      namedSet.setCount(visible ? named.length : 0);
      namedSet.commit();
      overlayHost.setEntries(LAYER_ID, entries, {
        cohortLimit: MILITARY_POINT_CAP,
        collisionCapacity: MILITARY_LABEL_CAP,
        maxVisible: MILITARY_LABEL_CAP - (layerState.selectedId ? 1 : 0),
        moving: false,
        visible,
      });
    },
    visit(visitor) {
      for (const record of namedRecords.values())
        visitor(record.id, {
          position: geo.cartesian3.fromDegrees(
            record.longitude,
            record.latitude,
          ),
        });
    },
    stats: () => ({
      namedMarkers: namedRecords.size,
      pointsOnScreen: 0,
      labelsOnScreen: 0,
      labelCap: MILITARY_LABEL_CAP,
    }),
    destroy() {
      this.hide();
      namedRecords.clear();
      namedSet.destroy();
    },
  };

  const rendering = {
    installationSurfaceHeightM: parts.model.installationSurfaceHeightM,
    clearSelectionFill,
    syncSelectionFill,
    clearRendered() {
      normalSet.setCount(0);
      selectedSet.setCount(0);
      normalSet.commit();
      selectedSet.commit();
      clearOutlines();
      clearSelectionFill();
      services.context.removeEntityContextsForLayer(LAYER_ID);
      contextObjects.clear();
    },
    renderableRecords() {
      const records = layerState.records
        .filter((record) => !record.pointOnly && !record.namedArea)
        .slice(0, MAX_RENDERED);
      const selected = layerState.recordById.get(layerState.selectedId);
      return selected && !records.some((record) => record.id === selected.id)
        ? [...records, selected]
        : records;
    },
    renderRecords,
    warmInstallationFloors(records) {
      const cold = records
        .filter(
          (record) =>
            services.ground.cachedGroundFloor(
              record.latitude,
              record.longitude,
            ) == null,
        )
        .map((record) => ({ lat: record.latitude, lon: record.longitude }));
      if (!cold.length) return;
      services.anchors.warmFireAnchorFloors(cold).then(() => {
        if (!layerState.enabled || destroyed) return;
        if (
          cold.some(
            (point) =>
              services.ground.cachedGroundFloor(point.lat, point.lon) != null,
          )
        )
          renderRecords();
      });
    },
  };

  const selection = {
    selectRecord,
    installInteraction() {
      if (interactionRemove) return;
      const dispatcher = selectionDispatcherFor(engine);
      if (!dispatcher)
        throw new Error('Installation selection dispatcher unavailable');
      interactionRemove = dispatcher.register(LAYER_ID, {
        owns: (id) => layerState.recordById.has(id),
        onSelect: selectRecord,
        onEmptyClick: deselect,
      });
      layerState.clickHandler = { destroy: interactionRemove };
      const events = [
        'gev:entity-selected',
        'gev:entity-selection-cleared',
        'gev:awareness-subject-selected',
      ];
      const sync = (event) => {
        if (!layerState.enabled) return;
        const selected =
          event?.type === 'gev:awareness-subject-selected'
            ? event.detail
            : services.context.getSelectedEntityContext();
        const next =
          selected?.layerId === LAYER_ID &&
          layerState.recordById.has(selected.id)
            ? selected.id
            : null;
        if (next === layerState.selectedId) return;
        layerState.selectedId = next;
        renderRecords();
      };
      for (const event of events)
        globalThis.window?.addEventListener?.(event, sync);
      removeContextListeners = () => {
        for (const event of events)
          globalThis.window?.removeEventListener?.(event, sync);
      };
    },
    destroy() {
      interactionRemove?.();
      interactionRemove = null;
      removeContextListeners?.();
      removeContextListeners = null;
    },
  };

  const lifecycle = {
    methods: {
      init(viewer, { engine: initEngine = engine } = {}) {
        layerState.viewer = viewer;
        layerState.engine = initEngine;
        const cameraChanged = () => {
          if (!layerState.contextAnchor) parts.viewport.scheduleLoad();
        };
        layerState.moveEndRemove =
          engine.camera.moveEnd.addEventListener(cameraChanged);
        layerState.changedRemove =
          engine.camera.changed.addEventListener(cameraChanged);
        selection.installInteraction(engine);
      },
      enable() {
        visible = true;
        layerState.enabled = true;
        for (const set of [normalSet, selectedSet]) set.setCount(0);
        normalSet.commit();
        selectedSet.commit();
        namedMarkers.enable();
        namedMarkers.sync(layerState.records || []);
        services.picking.registerPickOwner(LAYER_ID, (id) =>
          layerState.recordById.has(id),
        );
        renderRecords({ claimSelection: Boolean(layerState.selectedId) });
      },
      disable() {
        visible = false;
        layerState.enabled = false;
        services.credits?.hideOsmCredit?.(engine, LAYER_ID);
        syncPlacesCredit([]);
        namedMarkers.hide();
        layerState.contextAnchor = null;
        layerState.contextPosition = null;
        layerState.coverage = { kind: 'viewport' };
        layerState.cameraLoadKey = null;
        layerState.cameraLoadOwner = null;
        services.picking.unregisterPickOwner(LAYER_ID);
        parts.viewport.clearUnavailableRetry();
        clearTimeout(layerState.timer);
        layerState.abort?.abort();
        layerState.abort = null;
        layerState.loading = false;
        normalSet.setCount(0);
        selectedSet.setCount(0);
        normalSet.commit();
        selectedSet.commit();
        clearOutlines();
        clearSelectionFill();
        services.context.clearSelectedEntityContextForLayer(LAYER_ID);
        layerState.selectedId = null;
        parts.ingestion.setInstallationStatus('idle');
      },
      destroy() {
        source.destroy?.();
        this.disable();
        this.detach();
      },
      detach() {
        services.credits?.hideOsmCredit?.(engine, LAYER_ID);
        syncPlacesCredit([]);
        services.picking.unregisterPickOwner(LAYER_ID);
        layerState.moveEndRemove?.();
        layerState.changedRemove?.();
        layerState.moveEndRemove = layerState.changedRemove = null;
        selection.destroy();
        rendering.clearRendered();
        namedMarkers.destroy();
        drapeHandle?.delete();
        drapeHandle = null;
        normalSet.destroy();
        selectedSet.destroy();
        owner.scene = null;
        layerState.viewer = null;
        layerState.engine = null;
        destroyed = true;
      },
    },
  };

  return { lifecycle, namedMarkers, rendering, selection };
}
