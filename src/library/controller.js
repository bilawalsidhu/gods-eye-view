/**
 * The Data Library controller: which entries this instance offers, which the
 * viewer has added, and the lifetime of their layers.
 *
 * Core layers are registered once and sealed; library layers register only
 * when a viewer adds them (`LayerLifecycle.registerLibraryLayer`), so the
 * default panel stays the curated set and an unused entry costs nothing.
 */
import { LIBRARY_ENTRIES, LIBRARY_LEDGER } from './catalog.js';
import { libraryEntryIdOf, libraryLayerId } from './manifest.js';
import {
  decodeLibraryParam,
  encodeLibraryParam,
  normalizeLibrarySelection,
  readLibraryLedger,
  readStoredLibrarySelection,
  writeStoredLibrarySelection,
} from './selection.js';
import { createLibrarySource } from './source.js';
import {
  createLibraryDatasetLayer,
  createLibraryTileLayer,
  createLibraryViewLayer,
} from './layers.js';
import { isExplicitLayerStateOrigin } from '../data/layerState.js';

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.dataManager The sealed LayerLifecycle.
 * @param {object} options.services Local GeoJSON layer services.
 * @param {() => object|null} [options.getTileset] Photoreal tileset reader.
 * @param {object} [options.mapStackController]
 * @param {object} [options.shareLink] ShareLinkManager.
 * @param {string} [options.initialHash] The page hash at startup.
 * @param {(reason: string) => void} [options.requestRender]
 * @param {(extent: object) => boolean} [options.zoomTo] Fly to an extent
 *   through the shell's navigation authority; false when refused.
 */
export function createDataLibrary({
  entries = LIBRARY_ENTRIES,
  ledger = LIBRARY_LEDGER,
  dataManager,
  services,
  getTileset = () => null,
  mapStackController = null,
  shareLink = null,
  initialHash = globalThis.location?.hash ?? '',
  requestRender = () => {},
  zoomTo = null,
  storage = safeLocalStorage(),
  source = createLibrarySource({ entries }),
}) {
  if (!dataManager?.registerLibraryLayer)
    throw new TypeError('A sealed layer manager is required');
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const switchable = new Set(
    entries.filter(({ kind }) => kind !== 'pack').map(({ id }) => id),
  );
  const tokens = readLibraryLedger(ledger);
  let availability = new Map();
  let serverPresent = false;
  let selection = { added: [], on: [] };
  let started = false;
  // Set once availability is known; a share navigated to before then waits.
  let loaded = false;
  let queuedShare = null;
  let destroyed = false;
  const listeners = new Set();
  const pending = new Map();

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[Library] listener error:', error);
      }
    }
  };

  const persist = () => {
    selection = normalizeLibrarySelection(selection, switchable);
    writeStoredLibrarySelection(storage, selection);
    shareLink?.onLibraryStateChange?.();
    notify();
  };

  function createLayer(entry) {
    // No navigation owner, no Zoom chip: never a button that does nothing.
    const onZoom =
      typeof zoomTo === 'function'
        ? () => {
            zoom(entry.id).catch((error) =>
              console.warn(`[Library] ${entry.id} zoom failed:`, error),
            );
          }
        : null;
    const onRemove = () => {
      remove(entry.id).catch((error) =>
        console.warn(`[Library] ${entry.id} remove failed:`, error),
      );
    };
    if (entry.kind === 'dataset' && entry.source.view)
      return createLibraryViewLayer(entry, {
        source,
        onZoom,
        onRemove,
        requestRender,
      });
    if (entry.kind === 'dataset')
      return createLibraryDatasetLayer(entry, {
        services,
        source,
        onZoom,
        onRemove,
      });
    return createLibraryTileLayer(entry, {
      source,
      getTileset,
      mapStackController,
      requestRender,
      onZoom,
      onRemove,
    });
  }

  function isRegistered(id) {
    return dataManager.layers.has(libraryLayerId(id));
  }

  function register(entry) {
    if (isRegistered(entry.id)) return true;
    try {
      dataManager.registerLibraryLayer(createLayer(entry));
      return true;
    } catch (error) {
      console.warn(`[Library] ${entry.id} could not register:`, error);
      return false;
    }
  }

  function addable(id) {
    return switchable.has(id) && availability.get(id)?.available === true;
  }

  const unsubscribeManager = dataManager.subscribe?.((change) => {
    if (change?.type !== 'visibility') return;
    const id = libraryEntryIdOf(change.layerId);
    if (!id || !selection.added.includes(id)) return;
    // Like core layer state: only explicit choices are remembered, never a
    // Context session's temporary changes or a restore.
    if (!isExplicitLayerStateOrigin(change.origin)) {
      notify();
      return;
    }
    const on = new Set(selection.on);
    if (change.enabled) on.add(id);
    else on.delete(id);
    selection = { ...selection, on: [...on] };
    persist();
  });

  /** Entry ids for share tokens; unknown tokens are skipped. */
  const idsForTokens = (list) =>
    (list || []).map((token) => tokens.idByToken.get(token)).filter(Boolean);

  /**
   * The share this page opened with: null without one, else the entry ids it
   * switches on ([] for a share that switches none on).
   */
  function openingShare() {
    if (shareLink && shareLink.initialLibraryTokens !== undefined) {
      const linked = shareLink.initialLibraryTokens;
      return linked === null ? null : idsForTokens(linked);
    }
    const hash = String(initialHash || '').replace(/^#/, '');
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const linked = decodeLibraryParam(params, tokens.idByToken);
    // Any share (a camera position) decides what is on; no `lib`, nothing.
    if (linked === null && params.has('lat') && params.has('lon')) return [];
    return linked;
  }

  /**
   * Apply a selection: register and switch on what `on` names, switch off
   * every other added entry that is on. `origin` marks it as a restore so it
   * is never remembered as the viewer's own choice.
   */
  function applySelection(next, origin) {
    selection = normalizeLibrarySelection(next, switchable);
    for (const id of selection.added) {
      const entry = byId.get(id);
      if (!entry || !addable(id)) continue;
      const wanted = selection.on.includes(id);
      if (wanted && !register(entry)) continue;
      if (!isRegistered(id)) continue;
      const layerId = libraryLayerId(id);
      // Compare with the newest request, not settled state: a layer still
      // switching on for an earlier share must be switched off by this one.
      const current =
        dataManager.isEffectivelyEnabled?.(layerId) ??
        dataManager.isEnabled?.(layerId);
      if (wanted === (current === true)) continue;
      dataManager
        .setEnabled(layerId, wanted, { origin })
        .catch((error) =>
          console.warn(`[Library] ${id} restore failed:`, error),
        );
    }
    writeStoredLibrarySelection(storage, selection);
    shareLink?.onLibraryStateChange?.();
    notify();
  }

  /**
   * A share opened in this tab after start-up: its entries join the library
   * and it alone decides which are on.
   * @param {string[]} shareTokens
   */
  function applyShare(shareTokens) {
    if (destroyed) return;
    if (!loaded) {
      queuedShare = [...(shareTokens || [])];
      return;
    }
    const linked = idsForTokens(shareTokens);
    applySelection(
      { added: [...selection.added, ...linked], on: linked },
      'share-restore',
    );
  }
  shareLink?.setLibraryShareListener?.(applyShare);

  shareLink?.setLibraryParamsEncoder?.((params) =>
    encodeLibraryParam(
      params,
      selection.on.filter((id) => isRegistered(id)),
      tokens.tokenById,
    ),
  );

  /**
   * Read what this instance serves, then restore this browser's selection and
   * any `lib=` entries in the opening link.
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function start({ signal } = {}) {
    if (started || destroyed) return;
    started = true;
    const answer = await source.getAvailability({ signal });
    if (destroyed) return;
    availability = answer.availability;
    serverPresent = answer.server;
    const stored = readStoredLibrarySelection(storage, switchable);
    // A share opened in this tab while availability loaded wins over the
    // opening one.
    const linked = queuedShare ? idsForTokens(queuedShare) : openingShare();
    queuedShare = null;
    loaded = true;
    // A link's entries join the viewer's library and open switched on; with a
    // link, it alone decides what is on, as it does for core layers, so a
    // share with every library entry off switches the stored ones off.
    // Added entries register even while off, so their rows show.
    for (const id of [...stored.added, ...(linked || [])]) {
      const entry = byId.get(id);
      if (entry && addable(id)) register(entry);
    }
    applySelection(
      { added: [...stored.added, ...(linked || [])], on: linked ?? stored.on },
      linked ? 'share-restore' : 'local-restore',
    );
  }

  /**
   * Add an entry to the panel and switch it on.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function add(id) {
    if (destroyed || !addable(id) || pending.has(id)) return false;
    const entry = byId.get(id);
    const work = (async () => {
      if (!register(entry)) return false;
      selection = {
        added: [...selection.added.filter((other) => other !== id), id],
        on: selection.on,
      };
      persist();
      await dataManager.setEnabled(libraryLayerId(id), true, {
        origin: 'user',
      });
      return true;
    })();
    pending.set(id, work);
    notify();
    try {
      return await work;
    } finally {
      pending.delete(id);
      notify();
    }
  }

  /**
   * Remove an entry from the panel and destroy its layer.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function remove(id) {
    if (destroyed || pending.has(id)) return false;
    const work = (async () => {
      if (isRegistered(id))
        await dataManager.unregisterLibraryLayer(libraryLayerId(id));
      selection = {
        added: selection.added.filter((other) => other !== id),
        on: selection.on.filter((other) => other !== id),
      };
      persist();
      return true;
    })();
    pending.set(id, work);
    notify();
    try {
      return await work;
    } finally {
      pending.delete(id);
      notify();
    }
  }

  /**
   * Remove every added entry at once (the Browse dialog's reset).
   * @returns {Promise<number>} How many entries were removed.
   */
  async function reset() {
    if (destroyed) return 0;
    const ids = [...selection.added];
    let removed = 0;
    for (const id of ids) if (await remove(id)) removed += 1;
    return removed;
  }

  /** The area an added entry's layer covers, or null. */
  function extentOf(id) {
    return (
      dataManager.layers.get(libraryLayerId(id))?.module?.getExtent?.() ?? null
    );
  }

  /**
   * Fly to an added entry's layer, switching it on first when it is off: a
   * dataset only knows where its features are once loaded, and an off layer
   * has nothing to show at the destination.
   * @param {string} id
   * @returns {Promise<boolean>} Whether the flight started.
   */
  async function zoom(id) {
    if (destroyed || typeof zoomTo !== 'function' || !isRegistered(id))
      return false;
    const layerId = libraryLayerId(id);
    if (!dataManager.isEnabled?.(layerId))
      await dataManager.setEnabled(layerId, true, { origin: 'user' });
    const extent = extentOf(id);
    if (destroyed || !extent) return false;
    return zoomTo(extent) !== false;
  }

  /**
   * Everything the Browse view shows, in catalog order.
   * @returns {Array<{ entry: object, available: boolean, reason: string|null, added: boolean, on: boolean, busy: boolean }>}
   */
  function list() {
    return entries.map((entry) => {
      const state = availability.get(entry.id) || {
        available: false,
        reason: started ? 'server-unavailable' : null,
      };
      return {
        entry,
        available: state.available,
        reason: state.reason,
        added: selection.added.includes(entry.id) && isRegistered(entry.id),
        on: dataManager.isEnabled?.(libraryLayerId(entry.id)) === true,
        busy: pending.has(entry.id),
        canZoom: typeof zoomTo === 'function' && isRegistered(entry.id),
      };
    });
  }

  /**
   * The library at a glance, for the Browse dialog's stats strip.
   * `features` sums the features currently loaded by dataset layers that are
   * on; tiles are drapes and have no count.
   * @returns {{ entries: number, kinds: { dataset: number, tiles: number, pack: number }, themes: string[], available: number, unavailable: number, added: number, on: number, features: number, featureLayers: number }}
   */
  function summary() {
    const rows = list();
    const kinds = { dataset: 0, tiles: 0, pack: 0 };
    let features = 0;
    let featureLayers = 0;
    for (const row of rows) {
      kinds[row.entry.kind] += 1;
      if (!row.on || row.entry.kind !== 'dataset') continue;
      const count = dataManager.layers
        .get(libraryLayerId(row.entry.id))
        ?.module?.getStats?.()?.count;
      if (Number.isFinite(count) && count > 0) {
        features += count;
        featureLayers += 1;
      }
    }
    const available = rows.filter((row) => row.available).length;
    return {
      entries: rows.length,
      kinds,
      // Distinct themes (manifest families) the entries cover, sorted.
      themes: [...new Set(rows.map((row) => row.entry.family))].sort(),
      available,
      unavailable: rows.length - available,
      added: rows.filter((row) => row.added).length,
      on: rows.filter((row) => row.on).length,
      features,
      featureLayers,
    };
  }

  return {
    start,
    add,
    remove,
    summary,
    reset,
    zoom,
    list,
    get ready() {
      return started && availability.size > 0;
    },
    get serverPresent() {
      return serverPresent;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeManager?.();
      shareLink?.setLibraryParamsEncoder?.(null);
      shareLink?.setLibraryShareListener?.(null);
      listeners.clear();
    },
  };
}
