const STORE_KEY = '__gevContextStore';

export interface ContextRecord {
  id: string;
  layerId: string;
  entity: unknown;
  updatedAt: number;
  [key: string]: unknown;
}

interface Store {
  entities: Map<string, ContextRecord>;
  selectedEntityId: string | null;
  selectedAt: number | null;
}

function createStore(): Store {
  return {
    entities: new Map<string, ContextRecord>(),
    selectedEntityId: null,
    selectedAt: null,
  };
}

export function getContextStore(): Store {
  const gt = globalThis as unknown as Record<string, unknown>;
  if (!gt[STORE_KEY]) {
    gt[STORE_KEY] = createStore();
  }
  return gt[STORE_KEY] as Store;
}

/**
 * Is there a host to hang the store on?
 *
 * The tracking-subject helpers run inside the aircraft layers' per-poll
 * refresh, which unit tests drive with no DOM at all. Without this guard the
 * bare `window` read throws mid-poll and takes the rest of the refresh with it.
 */
function hasContextHost(): boolean {
  return typeof globalThis !== 'undefined' && Boolean(globalThis);
}

export function registerEntityContext(entity: unknown, metadata: Record<string, unknown>): ContextRecord | null {
  if (!entity || !metadata?.id) return null;
  const store = getContextStore();
  const id = String(metadata.id);
  const record: ContextRecord = {
    ...metadata,
    id,
    entity,
    updatedAt: Date.now(),
  } as ContextRecord;
  (entity as Record<string, unknown>).__gevContextId = id;
  store.entities.set(id, record);
  return record;
}

export function selectEntityContext(entity: unknown): ContextRecord | null {
  const store = getContextStore();
  const contextId = (entity as Record<string, unknown>)?.__gevContextId as string | undefined;
  if (!contextId || !store.entities.has(contextId)) return null;
  store.selectedEntityId = contextId;
  store.selectedAt = Date.now();
  const record = store.entities.get(contextId)!;
  globalThis.dispatchEvent(new CustomEvent('gev:entity-selected', { detail: record }));
  return record;
}

/**
 * Publish the live subject of a TRACKING layer (aircraft) into the shared
 * selection slot.
 *
 * Deliberately does NOT dispatch `gev:entity-selected`: tracking layers own a
 * separate publication lane (`gev:awareness-subject-selected`) that the
 * readout and Contacts panel already consume, and a second event for the same
 * click would make those two surfaces fight over one subject.
 *
 * A tracking layer has at most one subject, so any earlier record it left
 * behind is dropped — its feed refreshes continuously and a frozen snapshot
 * must never reach the visible-entity scan.
 */
export function selectTrackedSubjectContext(metadata: Record<string, unknown>): ContextRecord | null {
  if (!hasContextHost() || !metadata?.id || !metadata?.layerId) return null;
  const store = getContextStore();
  const id = String(metadata.id);
  for (const [key, record] of store.entities) {
    if (record?.layerId === metadata.layerId && key !== id) store.entities.delete(key);
  }
  // Reuse the existing carrier so a per-poll refresh does not churn identity.
  const existingRecord = store.entities.get(id);
  const carrier = existingRecord?.entity || { __gevContextId: id };
  const record = registerEntityContext(carrier as Record<string, unknown>, { ...metadata, id });
  if (!record) return null;
  store.selectedEntityId = id;
  store.selectedAt = Date.now();
  return record;
}

/**
 * Refresh a tracking layer's subject in place WITHOUT claiming the selection.
 *
 * The per-poll position/identity refresh must not resurrect a subject the
 * operator has since replaced by clicking something else.
 */
export function refreshTrackedSubjectContext(metadata: Record<string, unknown>): ContextRecord | null {
  if (!hasContextHost() || !metadata?.id || !metadata?.layerId) return null;
  const store = getContextStore();
  const id = String(metadata.id);
  const existing = store.entities.get(id);
  if (!existing || existing.layerId !== metadata.layerId) return null;
  return registerEntityContext(existing.entity as Record<string, unknown>, { ...metadata, id });
}

/**
 * Drop a tracking layer's subject when the operator deselects it.
 */
export function clearTrackedSubjectContext(layerId: string): void {
  if (!hasContextHost() || !layerId) return;
  const store = getContextStore();
  for (const [key, record] of store.entities) {
    if (record?.layerId === layerId) store.entities.delete(key);
  }
  if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
  }
}

export function getSelectedEntityContext(opts: { dataManager?: unknown } = {}): ContextRecord | null {
  const { dataManager = null } = opts;
  const store = getContextStore();
  if (!store.selectedEntityId) return null;
  const record = store.entities.get(store.selectedEntityId);
  if (!record || !isContextRecordActive(record, dataManager as null)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    return null;
  }
  return record;
}

/**
 * Drop the selected context record owned by a layer.
 * @param evicted - The record aged out of its feed rather than being deselected.
 */
export function clearSelectedEntityContextForLayer(layerId: string, opts: { evicted?: boolean } = {}): void {
  const { evicted = false } = opts;
  const store = getContextStore();
  if (!store.selectedEntityId) return;
  const record = store.entities.get(store.selectedEntityId);
  if (record?.layerId === layerId) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    globalThis.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', {
      detail: { layerId, reason: evicted ? 'evicted' : 'deliberate' },
    }));
  }
}

/** Remove obsolete context records when a viewport-scoped layer refreshes. */
export function removeEntityContextsForLayer(layerId: string): void {
  const store = getContextStore();
  for (const [id, record] of store.entities) {
    if (record?.layerId === layerId) store.entities.delete(id);
  }
  if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    // A viewport refresh dropped the record out from under the selection —
    // the user did not deselect anything.
    globalThis.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', {
      detail: { layerId, reason: 'evicted' },
    }));
  }
}

export function isContextRecordActive(record: ContextRecord | null, dataManager: unknown = null): boolean {
  if (!record) return false;
  if ((record.entity as Record<string, unknown>)?.show === false) return false;
  if (record.dataSource && (record.dataSource as Record<string, unknown>)?.show === false) return false;
  if (dataManager && record.layerId && !(dataManager as Record<string, (id: string) => boolean>)?.isEnabled?.(record.layerId)) return false;
  return true;
}
