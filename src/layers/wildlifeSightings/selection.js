import { t } from '../../i18n/index.js';
import { wildlifeMeasure } from './performance.js';
import { compareWildlifeIds } from './model.js';
import { isRecentWildlifeSighting } from './records.js';
import {
  ACARTIA_CREDIT,
  registerDynamicCredit,
} from '../../data/dataCredits.js';
import {
  WILDLIFE_OVERLAY_SOURCE_ID,
  WILDLIFE_SELECTED_SOURCE_ID,
  WILDLIFE_LABEL_SOURCE_ID,
  WILDLIFE_LABEL_SOURCE_OPTIONS,
  WILDLIFE_OVERLAY_SOURCE_OPTIONS,
  WILDLIFE_SELECTED_SOURCE_OPTIONS,
  buildWildlifeThumbnailEntry,
  buildWildlifeSelectedLabel,
  buildWildlifeLabelEntry,
  wildlifeCommonName,
  wildlifeDisplayName,
  wildlifeLabelScore,
  selectWildlifeAmbientRows,
} from './cards.js';
import {
  WILDLIFE_CARD_LIMIT,
  WILDLIFE_CARD_SHOW_MAX_METERS,
  WILDLIFE_CARD_HIDE_MAX_METERS,
  WILDLIFE_LABEL_NAME_SEPARATION_PX,
  WILDLIFE_SELECTED_LABEL_FADE_HIGH_METERS,
  WILDLIFE_LABEL_LIMIT,
} from './policy.js';

const CONTEXT_LIMIT = 30;

/** Overlay sources, pinned observation selection and external focus. */
export function createSelection({ state, services, parts }) {
  const overlay = services.overlayHost;
  const sourceIds = [
    WILDLIFE_OVERLAY_SOURCE_ID,
    WILDLIFE_LABEL_SOURCE_ID,
    WILDLIFE_SELECTED_SOURCE_ID,
  ];
  const listeners = new Set();
  // Coordinates are refreshed only by the existing camera/data label pass.
  const labelScreens = new Map();
  const ambientSourceOptions = {
    ...WILDLIFE_OVERLAY_SOURCE_OPTIONS,
    onVisibilityChange: (ids) => parts.rendering.setPhotoCardVisibility?.(ids),
  };

  function renderBatch(fn) {
    parts.rendering.beginBatch?.();
    try {
      return fn();
    } finally {
      parts.rendering.endBatch?.();
    }
  }

  function selectionRow() {
    if (!state.enabled || !state.selectedId) return null;
    return state.selectedRow || state.rowById.get(state.selectedId) || null;
  }

  function dispatch(listener, row, metadata) {
    try {
      listener(row, metadata);
    } catch {
      // A disconnected UI surface must not prevent map selection or teardown.
    }
  }

  function notify({ explicitSelection = false } = {}) {
    const row = selectionRow();
    const metadata = { explicitSelection: explicitSelection === true };
    for (const listener of listeners) dispatch(listener, row, metadata);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    if (!state.destroyed) listeners.add(listener);
    dispatch(listener, selectionRow(), { explicitSelection: false });
    return () => listeners.delete(listener);
  }

  const cardActions = {
    select: selectAndFocus,
    hasRow: (id) => state.enabled && state.rowById.has(id),
  };

  function publishAmbient() {
    return wildlifeMeasure('overlay-publish', publishAmbientEntries);
  }

  function publishAmbientEntries() {
    if (!state.enabled || !overlay) return;
    overlay.setEntries(
      WILDLIFE_OVERLAY_SOURCE_ID,
      state.ambientRows.map((row) => ({
        ...buildWildlifeThumbnailEntry(row, services.now(), {
          ...cardActions,
          image: parts.photos.get(row),
          selected: row.stableId === state.selectedId,
        }),
        position: state.positions.get(row.stableId),
      })),
      ambientSourceOptions,
    );
    parts.rendering.requestRender('photos');
  }

  function publishSelected() {
    return wildlifeMeasure('overlay-publish', publishSelectedEntries);
  }

  function publishSelectedEntries() {
    if (!state.enabled || !overlay) return;
    const row = selectionRow();
    // The selected sighting's painted thumbnail already shows its name.
    const label =
      row && !parts.rendering.hasPhotoCard?.(row.stableId)
        ? buildWildlifeSelectedLabel(row)
        : null;
    overlay.setEntries(
      WILDLIFE_SELECTED_SOURCE_ID,
      label
        ? [
            {
              ...label,
              position: state.positions.get(row.stableId),
            },
          ]
        : [],
      WILDLIFE_SELECTED_SOURCE_OPTIONS,
    );
  }

  function publishLabels() {
    return wildlifeMeasure('overlay-publish', publishLabelsEntries);
  }

  function publishLabelsEntries() {
    if (!state.enabled || !overlay) return;
    const names = new Map();
    const remember = (row) => {
      const screen = labelScreens.get(row.stableId);
      if (!screen) return;
      const name = wildlifeDisplayName(row);
      if (!names.has(name)) names.set(name, []);
      names.get(name).push(screen);
    };
    // Painted photos win regardless of score. Queued or rejected images do not
    // suppress neighbors. Selection wins over ambient names using the same cache.
    for (const row of state.ambientRows)
      if (parts.rendering.hasPhotoCard?.(row.stableId)) remember(row);
    const selected = selectionRow();
    if (
      selected &&
      (state.viewer.camera?.positionCartographic?.height ?? 0) <
        WILDLIFE_SELECTED_LABEL_FADE_HIGH_METERS
    )
      remember(selected);
    const entries = [];
    for (const row of state.labelRows || []) {
      if (
        row.stableId === state.selectedId ||
        parts.rendering.hasPhotoCard?.(row.stableId)
      )
        continue;
      const screen = labelScreens.get(row.stableId);
      const nearby = names.get(wildlifeDisplayName(row));
      if (
        screen &&
        nearby?.some(
          (other) =>
            (screen.x - other.x) ** 2 + (screen.y - other.y) ** 2 <
            WILDLIFE_LABEL_NAME_SEPARATION_PX ** 2,
        )
      )
        continue;
      const entry = buildWildlifeLabelEntry(row, {
        ...cardActions,
        nowMs: services.now(),
      });
      if (!entry) continue;
      entries.push({ ...entry, position: state.positions.get(row.stableId) });
      remember(row);
      if (entries.length >= WILDLIFE_LABEL_LIMIT) break;
    }
    overlay.setEntries(
      WILDLIFE_LABEL_SOURCE_ID,
      entries,
      WILDLIFE_LABEL_SOURCE_OPTIONS,
    );
    parts.rendering.requestRender('labels');
  }

  function refreshLabels() {
    if (!state.enabled || !overlay) return;
    const scene = state.viewer.scene;
    const horizon = parts.rendering.occluder();
    const width = scene.canvas?.clientWidth || 0;
    const height = scene.canvas?.clientHeight || 0;
    // Rank during camera/data passes; the host handles pixel collisions.
    const nowMs = services.now();
    const candidates = [];
    labelScreens.clear();
    const rows = new Map(state.renderedRows.map((row) => [row.stableId, row]));
    for (const row of state.ambientRows) rows.set(row.stableId, row);
    for (const row of rows.values()) {
      if (!wildlifeCommonName(row)) continue;
      const position = state.positions.get(row.stableId);
      if (!position || (horizon && horizon.isPointVisible(position) !== true))
        continue;
      const screen = services.project(scene, position);
      if (
        !screen ||
        screen.x < 0 ||
        screen.y < 0 ||
        screen.x > width ||
        screen.y > height
      )
        continue;
      labelScreens.set(row.stableId, { x: screen.x, y: screen.y });
      candidates.push(row);
    }
    candidates.sort(
      (a, b) =>
        wildlifeLabelScore(b, nowMs) - wildlifeLabelScore(a, nowMs) ||
        compareWildlifeIds(a.stableId, b.stableId),
    );
    // Keep ranked candidates so a disappearing photo or cleared selection can
    // restore suppressed names without another projection pass. Cap after dedup.
    state.labelRows = candidates;
    publishLabels();
  }

  function ambientCandidates(rows) {
    const scene = state.viewer.scene;
    const horizon = parts.rendering.occluder();
    const width = scene.canvas?.clientWidth ?? Infinity;
    const height = scene.canvas?.clientHeight ?? Infinity;
    const screens = new Map();
    const nowMs = services.now();
    const taxa = state.drawnParams?.taxa ?? state.taxa;
    const eligible = rows.filter((row) => {
      if (
        !row.photo ||
        row.obscured ||
        !isRecentWildlifeSighting(row, nowMs, taxa)
      )
        return false;
      const position = state.positions.get(row.stableId);
      if (!position || (horizon && horizon.isPointVisible(position) !== true))
        return false;
      const screen = services.project(scene, position);
      if (
        !screen ||
        screen.x < 0 ||
        screen.y < 0 ||
        screen.x > width ||
        screen.y > height
      )
        return false;
      screens.set(row.stableId, { x: screen.x, y: screen.y });
      return true;
    });
    return { eligible, screens, width, height };
  }

  /** Snapshot before acquisition replaces its sample. Only currently visible
   * photos survive; acquisition also checks the observation window/params. */
  function retainedAmbientRows() {
    if (!state.enabled) return [];
    const height =
      state.viewer?.camera?.positionCartographic?.height ?? Infinity;
    if (height >= WILDLIFE_CARD_HIDE_MAX_METERS) return [];
    return ambientCandidates(state.ambientRows).eligible;
  }

  function refreshAmbient() {
    if (!state.enabled) return;
    refreshLabels();
    const height =
      state.viewer?.camera?.positionCartographic?.height ?? Infinity;
    if (state.ambientActive) {
      if (height >= WILDLIFE_CARD_HIDE_MAX_METERS) state.ambientActive = false;
    } else if (height <= WILDLIFE_CARD_SHOW_MAX_METERS)
      state.ambientActive = true;
    if (!state.ambientActive) {
      state.ambientRows = [];
      state.ambientIds = [];
      parts.photos.setAmbient([]);
      publishAmbient();
      return;
    }
    // A bucket rebuild may hide an incumbent behind a newly sampled neighbor.
    // Retain its actual loaded row; rendering gives ambient IDs bucket priority.
    const byId = new Map(state.renderedRows.map((row) => [row.stableId, row]));
    for (const row of state.ambientRows) {
      const current = state.rowById.get(row.stableId);
      if (current) byId.set(row.stableId, current);
    }
    const candidates = ambientCandidates([...byId.values()]);
    state.ambientRows = selectWildlifeAmbientRows(
      candidates.eligible,
      state.ambientIds,
      services.now(),
      WILDLIFE_CARD_LIMIT,
      candidates,
    );
    state.ambientIds = state.ambientRows.map((row) => row.stableId);
    parts.photos.setAmbient(state.ambientRows);
    publishAmbient();
  }

  // iNaturalist is static; Acartia enters the attribution popover on first use.
  function syncCredits() {
    if (!state.enabled) return;
    if (state.renderedRows.some((row) => row.origin === 'acartia'))
      registerDynamicCredit(state.viewer, ACARTIA_CREDIT);
  }

  function registerContext(row) {
    if (!services.context?.registerEntityContext) return null;
    let carrier = state.carriers.get(row.stableId);
    if (!carrier) {
      carrier = { show: true };
      state.carriers.set(row.stableId, carrier);
    }
    carrier.__localBaseCartesian = state.positions.get(row.stableId);
    // A badge yielding to its photo or a neighbor is still a visible sighting.
    // Context visibility follows the anchor, independently of badge declutter.
    const horizon = parts.rendering.occluder();
    carrier.show =
      !horizon || horizon.isPointVisible(carrier.__localBaseCartesian) === true;
    const name = row.commonName || row.scientificName || t('Cetacean');
    // i18n-ignore: provider names and feed-supplied organism names are verbatim
    const label = `${name} · ${row.origin === 'acartia' ? 'Acartia' : 'iNaturalist'}`;
    services.context.registerEntityContext(carrier, {
      id: row.stableId,
      layerId: 'wildlife-sightings',
      layerName: t('Wildlife Sightings'),
      source: row.origin === 'acartia' ? 'Acartia' : 'iNaturalist',
      label,
      latitude: row.lat,
      longitude: row.lon,
      properties: {
        quality: row.quality,
        iconic: row.iconic,
        obscured: row.obscured,
      },
      select: () => selectAndFocus(row.stableId),
    });
    return carrier;
  }

  function refreshContexts() {
    if (!services.context) return;
    const rows = state.renderedRows.slice(0, CONTEXT_LIMIT);
    const selected = selectionRow();
    if (selected && !rows.includes(selected)) rows.push(selected);
    const next = new Set(rows.map((row) => row.stableId));
    try {
      for (const row of rows) registerContext(row);
      const store = services.context.getContextStore?.();
      for (const id of state.contextIds) {
        if (!next.has(id)) {
          if (store?.entities?.get(id)?.layerId === 'wildlife-sightings')
            store.entities.delete(id);
          state.carriers.delete(id);
        }
      }
    } catch {
      // Optional context surfaces must not prevent data or cards rendering.
    }
    state.contextIds = next;
  }

  function select(id, { publishContext = true } = {}) {
    return renderBatch(() => selectRecord(id, { publishContext }));
  }

  function selectRecord(id, { publishContext = true } = {}) {
    if (!state.enabled || !state.rowById.has(id)) return false;
    const row = state.rowById.get(id);
    state.selectedId = id;
    state.selectedRow = row;
    parts.rendering.refreshSelection();
    publishAmbient();
    publishLabels();
    publishSelected();
    try {
      const carrier = registerContext(row);
      state.contextIds.add(id);
      if (publishContext && carrier) {
        state.publishingContext = true;
        try {
          services.context?.selectEntityContext?.(carrier);
        } finally {
          state.publishingContext = false;
        }
      }
    } catch {
      state.publishingContext = false;
    }
    notify({ explicitSelection: true });
    parts.rendering.requestRender('select');
    return true;
  }

  function selectAndFocus(id, options = {}) {
    const row = state.rowById.get(typeof id === 'string' ? id : id?.stableId);
    if (!state.enabled || !row) return false;
    if (!select(row.stableId, options)) return false;
    services.focus?.requestWorldFocus?.({
      kind: row.obscured ? 'sighting-area' : 'sighting',
      id: row.stableId,
      label: row.commonName || row.scientificName || t('SIGHTING'),
      position: state.positions.get(row.stableId),
    });
    return true;
  }

  function clear() {
    return renderBatch(clearRecord);
  }

  function clearRecord() {
    const hadSelection = state.selectedId !== null;
    state.selectedId = null;
    state.selectedRow = null;
    try {
      services.context?.clearSelectedEntityContextForLayer?.(
        'wildlife-sightings',
      );
    } catch {
      /* optional context host is already gone */
    }
    if (state.enabled) {
      if (hadSelection) publishAmbient();
      publishSelected();
      if (hadSelection) publishLabels();
      if (hadSelection) parts.rendering.requestRender('select');
    }
    notify();
    return hadSelection;
  }

  function clearAndRebuild() {
    return renderBatch(() => {
      const hadSelection = clear();
      if (hadSelection) parts.rendering.refreshSelection();
      return hadSelection;
    });
  }

  function install() {
    const onContext = (event) => {
      if (!state.enabled || state.publishingContext) return;
      const record =
        event.detail || services.context?.getSelectedEntityContext?.();
      if (record?.layerId === 'wildlife-sightings')
        selectAndFocus(record.id, { publishContext: false });
    };
    services.eventTarget?.addEventListener?.('gev:entity-selected', onContext);
    state.removeContext = () =>
      services.eventTarget?.removeEventListener?.(
        'gev:entity-selected',
        onContext,
      );
    if (typeof services.screenSpaceEventHandlerFactory !== 'function') return;
    state.clickHandler = services.screenSpaceEventHandlerFactory(state.viewer);
    state.clickHandler.setInputAction((click) => {
      if (!state.enabled || services.pointer?.isPointerFree?.() === false)
        return;
      const hit =
        overlay?.hitTest?.(click.position?.x, click.position?.y, {
          sourceId: WILDLIFE_SELECTED_SOURCE_ID,
        }) ||
        overlay?.hitTest?.(click.position?.x, click.position?.y, {
          sourceId: WILDLIFE_OVERLAY_SOURCE_ID,
        }) ||
        overlay?.hitTest?.(click.position?.x, click.position?.y, {
          sourceId: WILDLIFE_LABEL_SOURCE_ID,
        });
      if (hit) {
        hit.entry?.activate?.();
        return;
      }
      const picked = state.viewer.scene.pick(click.position);
      const id =
        services.picking?.resolvePickId?.(picked) ??
        picked?.id ??
        picked?.primitive?.id;
      if (
        typeof id === 'string' &&
        id.startsWith('wildlife:') &&
        selectAndFocus(id.slice(9))
      )
        return;
      if (
        id &&
        services.picking?.isOwnedByOtherLayer?.('wildlife-sightings', id)
      )
        return;
      clearAndRebuild();
    }, services.cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function remove() {
    state.clickHandler?.destroy();
    state.clickHandler = null;
    state.removeContext?.();
    state.removeContext = null;
    clear();
    try {
      services.context?.removeEntityContextsForLayer?.('wildlife-sightings');
    } catch {
      /* optional context host is already gone */
    }
    state.carriers.clear();
    state.contextIds.clear();
    state.ambientIds = [];
    state.ambientRows = [];
    state.ambientActive = false;
    state.labelRows = [];
    labelScreens.clear();
    for (const id of sourceIds) {
      overlay?.clearSource?.(id);
      overlay?.setVisible?.(id, false);
    }
  }

  return {
    selectAndFocus,
    clear,
    clearAndRebuild,
    subscribe,
    notify,
    destroy() {
      listeners.clear();
    },
    install,
    remove,
    refreshAmbient,
    retainedAmbientRows,
    publishAmbient,
    publishSelected,
    photoCardsChanged() {
      renderBatch(() => {
        publishLabels();
        publishSelected();
      });
    },
    refreshContexts,
    syncCredits,
    sourceIds,
  };
}
