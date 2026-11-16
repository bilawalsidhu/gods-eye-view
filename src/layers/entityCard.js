/**
 * @module layers/entityCard
 *
 * Click-to-open card for layers whose map marks are renderer draw items.
 *
 * One controller per layer: it listens for a left click, asks the layer
 * whether the picked entity is one of its own, and shows that entity's card
 * through the overlay host's selected-card slot. Escape or a click on empty
 * globe closes the card. The layer owns the TEXT (it passes a `resolve`
 * function); this module owns the click, the pick ownership and the slot.
 *
 * Nothing here imports the app: the pick registry and the pointer-ownership
 * check arrive through `interaction`, so the module stays portable.
 */
import { inputFor as defaultInputFor } from '../input/dispatcher.js';

/** The overlay host slot options of a one-card source. */
export const ENTITY_CARD_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/**
 * The overlay entry for one open card.
 *
 * @param {string} id Pick id of the entity the card belongs to.
 * @param {{x: number, y: number, z: number}} position Where the card is
 *   anchored, in ECEF.
 * @param {{title: string, details?: string[]}} copy The card text.
 * @param {string} accent CSS colour.
 * @returns {object|null}
 */
export function createEntityCardOverlayEntry(id, position, copy, accent) {
  if (!id || !position) return null;
  return {
    id,
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: copy.details ?? [],
    accent,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * The id of what a click landed on: a draw item of this application, or
 * null. Reads the dispatcher's own hit, so one click is one pick.
 *
 * @param {{drawHit?: {id?: unknown}|null}|null} event
 * @returns {string|null}
 */
export function pickedEntityId(event) {
  const id = event?.drawHit?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * @param {object} options
 * @param {string} options.layerId Pick-owner id.
 * @param {object} options.overlayHost The shared overlay host.
 * @param {string} options.sourceId Overlay source id the card lives in.
 * @param {(id: string, click: {position: object|null}) =>
 *   ({title: string, details?: string[], accent: string,
 *     position?: object}|null)} options.resolve Card for a
 *   picked entity id, or null when the id is not this layer's.
 * @param {(id: string) => boolean} options.owns Whether the id is this
 *   layer's (so siblings leave the pick alone).
 * @param {(id: string) => void} [options.onSelect] Called with the opened id.
 * @param {() => void} [options.onClear] Called when the card closes.
 * @param {{registerPickOwner?: Function, unregisterPickOwner?: Function,
 *   isPointerFree?: () => boolean}} [options.interaction]
 * @param {(viewer: object) => {onClick: Function}} [options.inputFor] The
 *   pointer-input dispatcher of a scene; injectable for tests.
 */
export function createEntityCard({
  layerId,
  overlayHost,
  sourceId,
  resolve,
  owns,
  onSelect,
  onClear,
  interaction = {},
  inputFor = defaultInputFor,
}) {
  const isFree = interaction.isPointerFree ?? (() => true);
  let unsubscribe = null;
  let selectedId = null;

  function clear() {
    const had = selectedId !== null;
    selectedId = null;
    overlayHost.clearSource(sourceId);
    if (had) onClear?.();
  }

  function select(id, click = { position: null }) {
    const copy = resolve(id, click);
    const entry = copy
      ? createEntityCardOverlayEntry(
          id,
          copy.position ?? click.position,
          copy,
          copy.accent,
        )
      : null;
    if (!entry) return false;
    selectedId = id;
    overlayHost.setEntries(sourceId, [entry], ENTITY_CARD_SOURCE_OPTIONS);
    onSelect?.(id);
    return true;
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') clear();
  }

  return {
    get selectedId() {
      return selectedId;
    },
    select,
    clear,

    install(viewer) {
      if (unsubscribe || !viewer) return;
      overlayHost.setVisible(sourceId, true);
      interaction.registerPickOwner?.(layerId, owns);
      unsubscribe = inputFor(viewer).onClick((event) => {
        // A pointer a tool has claimed is not an ambient selection.
        if (!isFree()) return;
        const id = pickedEntityId(event);
        if (id && owns(id)) {
          // Zones are lines: anchor their card where the click landed.
          if (select(id, { position: event.ground?.() ?? null })) return;
        }
        clear();
      });
      if (typeof document !== 'undefined')
        document.addEventListener('keydown', onKeyDown);
    },

    remove() {
      unsubscribe?.();
      unsubscribe = null;
      if (typeof document !== 'undefined')
        document.removeEventListener('keydown', onKeyDown);
      interaction.unregisterPickOwner?.(layerId);
      clear();
      overlayHost.setVisible(sourceId, false);
    },
  };
}
