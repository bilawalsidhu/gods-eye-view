// Elements a Data Layers row borrows while it shows them (RowPanel.vue):
// each moves into the row's slot and back to where it came from, the same
// element, so whatever holds it (a view's controls, read once by id) keeps
// working, and it never leaves the page with a slot that goes.

import { shallowReactive } from 'vue';

// An active control can keep its row slot after the layer's own controls hide.
const retained = shallowReactive(new Map());

export function retainRowPanel(layerId, element) {
  retained.set(layerId, element);
  return () => {
    if (retained.get(layerId) === element) retained.delete(layerId);
  };
}

export const retainedRowPanelId = (layerId) => retained.get(layerId)?.id;

/** Where each lent element came from: its parent and the node after it. */
const homes = new Map();

/**
 * Move the element into the slot, remembering where it was.
 * @param {string} id The element's id.
 * @param {HTMLElement|null} slot
 * @returns {boolean} Whether it moved.
 */
export function lendRowPanel(id, slot) {
  const element = slot?.ownerDocument?.getElementById(id);
  if (!element || element.parentElement === slot) return false;
  if (!homes.has(id) || !homes.get(id).parent.isConnected)
    homes.set(id, {
      parent: element.parentElement,
      next: element.nextSibling,
    });
  slot.appendChild(element);
  return true;
}

/**
 * Put the element back where it was, if it is still in this slot.
 * @param {string} id
 * @param {HTMLElement|null} slot
 */
export function returnRowPanel(id, slot) {
  const home = homes.get(id);
  const element = slot?.ownerDocument?.getElementById(id);
  if (!home || !element || element.parentElement !== slot) return;
  const next = home.next?.parentNode === home.parent ? home.next : null;
  home.parent.insertBefore(element, next);
}
