import { sceneServicesFor } from './sceneServices.js';

const STORE_KEY = '__gevContextStore';
const contextOwners = new WeakMap();

function createStore() {
  return {
    entities: new Map(),
    selectedEntityId: null,
    selectedAt: null,
  };
}

export function getContextStore() {
  if (!window[STORE_KEY]) {
    window[STORE_KEY] = createStore();
  }
  return window[STORE_KEY];
}

/**
 * Is there a window to hang the store on?
 *
 * The tracking-subject helpers run inside the aircraft layers' per-poll
 * refresh, which unit tests drive with no DOM at all. Without this guard the
 * bare `window` read throws mid-poll and takes the rest of the refresh with
 * it.
 * @returns {boolean} True when the store is reachable.
 */
function hasContextHost() {
  return typeof window !== 'undefined' && Boolean(window);
}

/** Selection records and notifications for one attachment, mirrored to page consumers. */
export function createSceneContext(retainedSelection = null) {
  return createContext(true, retainedSelection);
}

function createContext(scoped = false, retainedSelection = null) {
  const local = scoped ? createStore() : null;
  const events = new EventTarget();
  let destroyed = false;
  const storeForContext = () => local ?? getContextStore();
  const available = () => !destroyed && (scoped || hasContextHost());

  function dispatch(event, publishPage = true) {
    if (destroyed) return;
    if (scoped)
      events.dispatchEvent(
        new CustomEvent(event.type, { detail: event.detail }),
      );
    if (publishPage && hasContextHost()) window.dispatchEvent(event);
  }

  function ownsPageSelection(store) {
    if (!scoped) return true;
    if (!hasContextHost()) return false;
    const page = getContextStore();
    const record = store.entities.get(store.selectedEntityId);
    return Boolean(
      record && page.entities.get(page.selectedEntityId) === record,
    );
  }

  function clearSelection(store) {
    if (scoped && hasContextHost()) {
      const page = getContextStore();
      const record = store.entities.get(store.selectedEntityId);
      if (record && page.entities.get(page.selectedEntityId) === record) {
        page.selectedEntityId = null;
        page.selectedAt = null;
      }
    }
    store.selectedEntityId = null;
    store.selectedAt = null;
  }

  function deleteRecord(store, id) {
    if (scoped && hasContextHost()) {
      const page = getContextStore();
      if (page.entities.get(id) === store.entities.get(id)) {
        page.entities.delete(id);
        if (page.selectedEntityId === id) {
          page.selectedEntityId = null;
          page.selectedAt = null;
        }
      }
    }
    store.entities.delete(id);
  }

  function registerEntityContext(entity, metadata) {
    if (destroyed || !entity || !metadata?.id) return null;
    const store = storeForContext();
    const record = {
      ...metadata,
      entity,
      updatedAt: Date.now(),
    };
    entity.__gevContextId = metadata.id;
    if (scoped) contextOwners.set(entity, context);
    const previous = store.entities.get(metadata.id);
    store.entities.set(metadata.id, record);
    if (scoped && hasContextHost()) {
      const page = getContextStore();
      if (
        page.selectedEntityId !== metadata.id ||
        page.entities.get(metadata.id) === previous
      )
        page.entities.set(metadata.id, record);
    }
    if (
      scoped &&
      store.selectedEntityId === metadata.id &&
      previous?.entity !== entity
    )
      dispatch(
        new CustomEvent('gev:entity-selected', { detail: record }),
        false,
      );
    return record;
  }

  function selectEntityContext(entity) {
    if (destroyed) return;
    const store = storeForContext();
    const contextId = entity?.__gevContextId;
    if (!contextId || !store.entities.has(contextId)) return null;
    store.selectedEntityId = contextId;
    store.selectedAt = Date.now();
    if (scoped && hasContextHost()) {
      const page = getContextStore();
      page.entities.set(
        store.selectedEntityId,
        store.entities.get(store.selectedEntityId),
      );
      page.selectedEntityId = store.selectedEntityId;
      page.selectedAt = store.selectedAt;
    }
    const record = store.entities.get(contextId);
    dispatch(new CustomEvent('gev:entity-selected', { detail: record }));
    return record;
  }

  /**
   * Publish the live subject of a TRACKING layer (aircraft) into the shared
   * selection slot.
   *
   * Selecting a contact is a click-selection like any other — voice's
   * `scope:'selected'` and the Cockpit's selected-target lookup both read this
   * one slot, so a tracking layer that stays out of it is invisible to them
   * even while its readout card is on screen.
   *
   * Deliberately does NOT dispatch `gev:entity-selected`: tracking layers own a
   * separate publication lane (`gev:awareness-subject-selected`) that the
   * readout and Contacts panel already consume, and a second event for the same
   * click would make those two surfaces fight over one subject.
   *
   * A tracking layer has at most one subject, so any earlier record it left
   * behind is dropped — its feed refreshes continuously and a frozen snapshot
   * must never reach the visible-entity scan.
   *
   * @param {object} metadata Record fields; `id` and `layerId` required.
   * @returns {object|null} The stored record, or null when identity is missing.
   */
  function selectTrackedSubjectContext(metadata) {
    if (!available() || !metadata?.id || !metadata?.layerId) return null;
    const store = storeForContext();
    const id = String(metadata.id);
    for (const [key, record] of store.entities) {
      if (record?.layerId === metadata.layerId && key !== id)
        deleteRecord(store, key);
    }
    // Reuse the existing carrier so a per-poll refresh does not churn identity.
    const carrier = store.entities.get(id)?.entity || { __gevContextId: id };
    const record = registerEntityContext(carrier, { ...metadata, id });
    if (!record) return null;
    store.selectedEntityId = id;
    store.selectedAt = Date.now();
    if (scoped && hasContextHost()) {
      const page = getContextStore();
      page.entities.set(
        store.selectedEntityId,
        store.entities.get(store.selectedEntityId),
      );
      page.selectedEntityId = store.selectedEntityId;
      page.selectedAt = store.selectedAt;
    }
    return record;
  }

  /**
   * Refresh a tracking layer's subject in place WITHOUT claiming the selection.
   *
   * The per-poll position/identity refresh must not resurrect a subject the
   * operator has since replaced by clicking something else.
   * @param {object} metadata Record fields; `id` and `layerId` required.
   * @returns {object|null} The stored record, or null when it is not registered.
   */
  function refreshTrackedSubjectContext(metadata) {
    if (!available() || !metadata?.id || !metadata?.layerId) return null;
    const store = storeForContext();
    const id = String(metadata.id);
    const existing = store.entities.get(id);
    if (!existing || existing.layerId !== metadata.layerId) return null;
    return registerEntityContext(existing.entity, { ...metadata, id });
  }

  /**
   * Drop a tracking layer's subject when the operator deselects it.
   *
   * Pairs with {@link selectTrackedSubjectContext} and stays event-free for the
   * same reason: `gev:awareness-subject-cleared` is the tracking layers' lane.
   * @param {string} layerId Owning layer.
   * @returns {void}
   */
  function clearTrackedSubjectContext(layerId) {
    if (!available() || !layerId) return;
    const store = storeForContext();
    for (const [key, record] of store.entities) {
      if (record?.layerId === layerId) deleteRecord(store, key);
    }
    if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
      clearSelection(store);
    }
  }

  function getSelectedEntityContext({ dataManager = null } = {}) {
    const store = storeForContext();
    if (!store.selectedEntityId) return null;
    const record = store.entities.get(store.selectedEntityId);
    if (!record || !isContextRecordActive(record, dataManager)) {
      clearSelection(store);
      return null;
    }
    return record;
  }

  /**
   * Drop the selected context record owned by a layer.
   * @param {string} layerId Owning layer.
   * @param {object} [options] Clear origin.
   * @param {boolean} [options.evicted=false] The record aged out of its feed
   *   rather than being deselected. Readouts that stay on screen hold their
   *   last-known values for an eviction and only tear down on a deliberate clear.
   */
  function clearSelectedEntityContextForLayer(
    layerId,
    { evicted = false } = {},
  ) {
    if (destroyed) return;
    const store = storeForContext();
    if (!store.selectedEntityId) return;
    const record = store.entities.get(store.selectedEntityId);
    if (record?.layerId === layerId) {
      const publishPage = ownsPageSelection(store);
      clearSelection(store);
      dispatch(
        new CustomEvent('gev:entity-selection-cleared', {
          detail: { layerId, reason: evicted ? 'evicted' : 'deliberate' },
        }),
        publishPage,
      );
    }
  }

  /**
   * Remove obsolete context records when a viewport-scoped layer refreshes.
   * Optional retainIds keeps surviving records and their current selection intact.
   */
  function removeEntityContextsForLayer(layerId, { retainIds } = {}) {
    if (destroyed) return;
    const store = storeForContext();
    const publishPage = ownsPageSelection(store);
    for (const [id, record] of store.entities) {
      if (record?.layerId === layerId && !retainIds?.has(id))
        deleteRecord(store, id);
    }
    if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
      clearSelection(store);
      // A viewport refresh dropped the record out from under the selection —
      // the user did not deselect anything.
      dispatch(
        new CustomEvent('gev:entity-selection-cleared', {
          detail: { layerId, reason: 'evicted' },
        }),
        publishPage,
      );
    }
  }

  const context = {
    getContextStore: storeForContext,
    events,
    publishAwareness(type, detail) {
      dispatch(new CustomEvent(type, { detail }));
    },
    registerEntityContext,
    removeEntityContext(id) {
      if (!destroyed) deleteRecord(storeForContext(), id);
    },
    selectEntityContext,
    selectTrackedSubjectContext,
    refreshTrackedSubjectContext,
    clearTrackedSubjectContext,
    getSelectedEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    destroy({ retainSelection = false } = {}) {
      if (destroyed) return null;
      const retained =
        retainSelection && local && ownsPageSelection(local)
          ? local.entities.get(local.selectedEntityId)
          : null;
      destroyed = true;
      if (local) {
        for (const id of local.entities.keys()) {
          const entity = local.entities.get(id).entity;
          if (contextOwners.get(entity) === context)
            contextOwners.delete(entity);
          if (id !== retained?.id) deleteRecord(local, id);
        }
        local.entities.clear();
        clearSelection(local);
      }
      return retained;
    },
  };
  // Only an explicit handoff can adopt a page selection; a background scene
  // never takes it merely because it registers the same id.
  if (retainedSelection && hasContextHost()) {
    const page = getContextStore();
    if (page.entities.get(page.selectedEntityId) === retainedSelection) {
      local.entities.set(retainedSelection.id, retainedSelection);
      local.selectedEntityId = retainedSelection.id;
      local.selectedAt = page.selectedAt;
      contextOwners.set(retainedSelection.entity, context);
    }
  }
  return context;
}

const pageContext = createContext();
export const registerEntityContext = (entity, metadata) =>
  (contextOwners.get(entity) ?? pageContext).registerEntityContext(
    entity,
    metadata,
  );

// Page actions use the owner of their target, or of the page's current selection.
export function selectEntityContext(entity) {
  const page = getContextStore();
  const owner =
    contextOwners.get(entity) ??
    contextOwners.get(page.entities.get(page.selectedEntityId)?.entity);
  if (!owner) return pageContext.selectEntityContext(entity);
  const record = page.entities.get(entity?.__gevContextId);
  if (record && !contextOwners.has(entity))
    owner.registerEntityContext(entity, record);
  return owner.selectEntityContext(entity);
}

export const removeEntityContext = (...args) =>
  pageContext.removeEntityContext(...args);
export const selectTrackedSubjectContext = (...args) =>
  pageContext.selectTrackedSubjectContext(...args);
export const refreshTrackedSubjectContext = (...args) =>
  pageContext.refreshTrackedSubjectContext(...args);
export const clearTrackedSubjectContext = (...args) =>
  pageContext.clearTrackedSubjectContext(...args);
export const getSelectedEntityContext = (...args) =>
  pageContext.getSelectedEntityContext(...args);
export function clearSelectedEntityContextForLayer(...args) {
  const page = getContextStore();
  const owner = contextOwners.get(
    page.entities.get(page.selectedEntityId)?.entity,
  );
  return (owner ?? pageContext).clearSelectedEntityContextForLayer(...args);
}
export const removeEntityContextsForLayer = (...args) =>
  pageContext.removeEntityContextsForLayer(...args);

export function forEngine(engine) {
  return sceneServicesFor(engine)?.context ?? null;
}

export function isContextRecordActive(record, dataManager = null) {
  if (!record) return false;
  if (record.entity?.show === false) return false;
  if (record.isVisible?.() === false) return false;
  if (record.dataSource && record.dataSource.show === false) return false;
  if (dataManager && record.layerId && !dataManager.isEnabled(record.layerId))
    return false;
  return true;
}
