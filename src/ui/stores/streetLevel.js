import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * @typedef {object} StreetLevelHandlers
 * @property {(stop: number) => void} setSinceStop Record a SINCE stop.
 * @property {(stop: number) => string} describeSinceStop A stop's readout.
 */

/**
 * The Street Level panel as its view renders it. StreetLevelControls owns
 * the presentation (`presentStreetLevelPanel()`), the viewer and EXPAND: it
 * publishes here and attaches the actions the view forwards.
 */
export const useStreetLevelStore = defineStore('gev-street-level', () => {
  /** The presented panel; null until an owner renders, then its last render. */
  const view = shallowRef(null);
  /** Whether EXPAND has the viewer full screen; null until first synced. */
  const expanded = shallowRef(null);
  /** False on a page with neither element fullscreen nor popovers. */
  const expandAvailable = shallowRef(true);
  /** @type {{handlers: StreetLevelHandlers}|null} */
  let owner = null;

  /**
   * Present the panel for an owner, replacing any earlier owner.
   * @param {StreetLevelHandlers} handlers
   * @returns {object} Token for detach().
   */
  function attach(handlers) {
    owner = { handlers };
    return owner;
  }

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  /** @param {boolean} on */
  function setExpanded(on) {
    expanded.value = Boolean(on);
  }

  /** @param {boolean} available */
  function setExpandAvailable(available) {
    expandAvailable.value = Boolean(available);
  }

  /**
   * Stop forwarding actions to the owner holding `token`. The panel keeps
   * its last render, as the page did when its controls were wired by hand.
   */
  function detach(token) {
    if (owner === token) owner = null;
  }

  /** Forward a view action to the owner. */
  function act(name, ...args) {
    owner?.handlers[name]?.(...args);
  }

  /** The readout of a SINCE stop while its thumb is dragged. */
  function describeSinceStop(stop) {
    return owner?.handlers.describeSinceStop?.(stop) ?? '';
  }

  return {
    view,
    expanded,
    expandAvailable,
    attach,
    publish,
    setExpanded,
    setExpandAvailable,
    detach,
    act,
    describeSinceStop,
  };
});
