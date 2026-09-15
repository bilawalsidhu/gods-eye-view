import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  LAYER_ID,
  LAYER_NAME,
  OVERLAY_COHORT_LIMIT,
  OVERLAY_COLLISION_CAPACITY,
  SELECTED_PIXEL_SIZE,
  WORLD_NEWS_OVERLAY_SOURCE_ID,
} from './policy.js';
import {
  buildLabelModel,
  createPlaceOverlayEntry,
  placePixelSize,
  selectOverlayCohort,
  toneColor,
} from './model.js';

/**
 * Own the Cesium half of the layer: one clamped point per place group, the
 * ambient place labels, click selection and the readout-card model.
 * Records stay in `state` (pure); this module only reconciles the scene to
 * them. Context records carry the headline, place and publisher — never
 * authors or person/organization entities.
 */
export function createWorldNewsPresentation({
  state,
  services,
  overlayHost,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
}) {
  const { governorRequestRender } = services.render;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context;
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;

  function notifyRowControls() {
    try {
      state.rowControlsListener?.();
    } catch (error) {
      console.warn('[Data:WorldNews] row-controls listener failed:', error);
    }
  }

  function selectedGroup() {
    return state.selectedId ? state.groupById.get(state.selectedId) : null;
  }

  function selectedEntity() {
    return state.selectedId
      ? state.dataSource?.entities.getById(state.selectedId) || null
      : null;
  }

  function applyAppearance(entity, group, selected) {
    const base = placePixelSize(group.count);
    entity.point.pixelSize = selected
      ? Math.max(SELECTED_PIXEL_SIZE, base + 4)
      : base;
    entity.point.color = selected ? Cesium.Color.WHITE : toneColor(group.band);
  }

  function publishLabelModel(entity, group, storyIndex, nowMs) {
    entity.gevLabelModel = buildLabelModel(group, storyIndex, nowMs);
  }

  /** Reconcile one point entity per place group; untouched pins are kept. */
  function renderPlaces(nowMs = Date.now()) {
    if (!state.dataSource) return;
    const entities = state.dataSource.entities;
    const retainIds = new Set(state.groupById.keys());
    // Settle the selection BEFORE pruning: clearing after the context record
    // is gone fails the ownership guard inside the store and emits nothing.
    if (state.selectedId && !retainIds.has(state.selectedId))
      clearSelection({ evicted: true });
    // A refresh may retain its own selection, never reclaim one cleared or
    // replaced by another layer or a voice action.
    const selectedContext = getSelectedEntityContext();
    if (
      state.selectedId &&
      (selectedContext?.layerId !== LAYER_ID ||
        selectedContext.id !== state.selectedId)
    ) {
      state.selectedId = null;
      state.storyIndex = 0;
    }
    for (const entity of [...entities.values]) {
      if (!retainIds.has(entity.id)) entities.remove(entity);
    }
    removeEntityContextsForLayer(LAYER_ID, { retainIds });
    const overlayEntries = [];
    for (const group of state.groups) {
      const selected = group.id === state.selectedId;
      if (selected && state.storyIndex >= group.count) state.storyIndex = 0;
      let entity = entities.getById(group.id);
      const previous = entity?.gevNewsGroup;
      if (
        !previous ||
        previous.lat !== group.lat ||
        previous.lon !== group.lon
      ) {
        const position = Cesium.Cartesian3.fromDegrees(group.lon, group.lat);
        if (!entity) {
          entity = entities.add({
            id: group.id,
            position,
            point: {
              pixelSize: placePixelSize(group.count),
              color: toneColor(group.band),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        } else {
          entity.position = position;
        }
        entity.gevNewsPosition = position;
      }
      entity.gevNewsGroup = group;
      entity.gevTrackedId = group.id;
      // The readout card requires a FUNCTION; the cached anchor avoids a
      // per-frame Cartesian allocation while the card is on screen.
      entity.gevDisplayPosition = () => entity.gevNewsPosition;
      applyAppearance(entity, group, selected);
      publishLabelModel(entity, group, selected ? state.storyIndex : 0, nowMs);
      const newest = group.articles[0] || null;
      registerEntityContext(entity, {
        id: group.id,
        layerId: LAYER_ID,
        dataSource: state.dataSource,
        layerName: LAYER_NAME,
        source: 'World News API',
        label: 'Headline place',
        latitude: group.lat,
        longitude: group.lon,
        properties: {
          place: group.place,
          count: group.count,
          newestPublishedAt: newest?.publishedAt ?? null,
          headline: newest?.title ?? null,
          domain: newest?.domain ?? null,
          url: newest?.url ?? null,
        },
      });
      overlayEntries.push(
        createPlaceOverlayEntry({
          id: group.id,
          position: entity.gevNewsPosition,
          place: group.place,
          count: group.count,
          band: group.band,
          newestMs: group.newestMs,
        }),
      );
    }
    if (state.enabled) {
      overlayHost.setEntries(
        WORLD_NEWS_OVERLAY_SOURCE_ID,
        selectOverlayCohort(overlayEntries),
        {
          cohortLimit: OVERLAY_COHORT_LIMIT,
          collisionCapacity: OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
    const selected = selectedEntity();
    if (selected) services.overlays?.refreshReadout?.(selected);
    governorRequestRender('world-news');
  }

  function selectPlace(id) {
    const group = state.groupById.get(id);
    const entity = state.dataSource?.entities.getById(id);
    if (!group || !entity) return false;
    clearSelection();
    state.selectedId = id;
    state.storyIndex = 0;
    applyAppearance(entity, group, true);
    publishLabelModel(entity, group, 0, Date.now());
    selectEntityContext(entity);
    governorRequestRender('world-news');
    notifyRowControls();
    return true;
  }

  function stepStory(delta) {
    const group = selectedGroup();
    const entity = selectedEntity();
    if (!group || !entity || group.count < 2) return false;
    state.storyIndex =
      (((state.storyIndex + delta) % group.count) + group.count) % group.count;
    publishLabelModel(entity, group, state.storyIndex, Date.now());
    services.overlays?.refreshReadout?.(entity);
    governorRequestRender('world-news');
    notifyRowControls();
    return true;
  }

  function clearSelection({ evicted = false } = {}) {
    const group = selectedGroup();
    const entity = selectedEntity();
    if (group && entity) {
      applyAppearance(entity, group, false);
      publishLabelModel(entity, group, 0, Date.now());
    }
    state.selectedId = null;
    state.storyIndex = 0;
    clearSelectedEntityContextForLayer(LAYER_ID, { evicted });
    governorRequestRender('world-news');
    notifyRowControls();
  }

  function clearRendered() {
    overlayHost.clearSource(WORLD_NEWS_OVERLAY_SOURCE_ID);
    if (state.dataSource?.entities) state.dataSource.entities.removeAll();
    removeEntityContextsForLayer(LAYER_ID);
    governorRequestRender('world-news');
  }

  function installInteraction(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = screenSpaceEventHandlerFactory(viewer);
    state.clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!state.enabled) return;
      const picked = viewer.scene.pick(click.position);
      const id = resolvePickId(picked);
      if (id && state.groupById.has(id)) {
        if (id !== state.selectedId || getSelectedEntityContext()?.id !== id)
          selectPlace(id);
        return;
      }
      // A pick that belongs to a sibling layer (e.g. an aircraft) is not
      // "empty space" — leave the selection alone and let that layer handle it.
      if (id && isOwnedByOtherLayer(LAYER_ID, id)) return;
      if (state.selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function destroyInteraction() {
    state.clickHandler?.destroy();
    state.clickHandler = null;
  }

  return {
    renderPlaces,
    selectPlace,
    nextStory: () => stepStory(1),
    prevStory: () => stepStory(-1),
    clearSelection,
    clearRendered,
    installInteraction,
    destroyInteraction,
    notifyRowControls,
    selectedGroup,
  };
}
