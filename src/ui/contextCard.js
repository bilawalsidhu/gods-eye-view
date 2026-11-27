/**
 * The Context panel's item card, for custom layers: open
 * it on an item, close it, and hear when the map selection changes (a click
 * on an item a layer draws selects it). The app's Context connects the card
 * when it starts (ui/entityContextBridge.js); before that, and when the app
 * has no Context, nothing opens.
 *
 * An item is `{layerId, id, label?, lat?, lon?, record?}`: the card lists
 * the facts of `record` when given, else of the layer's own record with that
 * id (its `getAnalystRecords`), as it does for a click or a Nearby row.
 */

let connected = null;

const selectionListeners = new Set();

/**
 * Connect the card (ui/entityContextBridge.js).
 * @param {{select: (item: object) => boolean, clear: () => void}|null} card
 * @returns {() => void} Disconnect, unless another card has connected since.
 */
export function _connectContextCard(card) {
  connected = card;
  return () => {
    if (connected === card) connected = null;
  };
}

/**
 * The map selection changed (ui/entityContextBridge.js passes on
 * data/clickSelect.js): tell the listeners, as `{layerId, id}` or null.
 */
export function _mapSelectionChanged(selection, previous) {
  const now = publicSelection(selection);
  const before = publicSelection(previous);
  for (const cb of [...selectionListeners]) {
    if (!selectionListeners.has(cb)) continue;
    try {
      cb(now, before);
    } catch (error) {
      console.warn('[contextCard] a selection listener failed', error);
    }
  }
}

/**
 * Open the Context card on an item, and the panel with it. Nothing opens
 * while Cockpit runs.
 * @param {{layerId: string, id: string|number, label?: string, lat?: number, lon?: number, record?: object}} item
 * @returns {boolean} Whether a card could be made for it.
 */
export function openContextCard(item) {
  const id = item?.id == null ? '' : String(item.id);
  if (!connected || !item?.layerId || !id) return false;
  try {
    return connected.select({ ...item, id }) === true;
  } catch (error) {
    console.warn('[contextCard] the card could not open', error);
    return false;
  }
}

/** Close the Context card. */
export function closeContextCard() {
  connected?.clear();
}

/**
 * Run `cb(selection, previous)` whenever the map selection changes hands or
 * is let go: `{layerId, id}`, or null when nothing is selected. Heard once
 * the app's Context has started.
 * @param {(selection: {layerId: string, id: string|null}|null, previous: {layerId: string, id: string|null}|null) => void} cb
 * @returns {() => void} Off.
 */
export function onMapSelectionChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  selectionListeners.add(cb);
  return () => selectionListeners.delete(cb);
}

function publicSelection(selection) {
  return selection
    ? { layerId: selection.layerId, id: selection.id ?? null }
    : null;
}
