import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * @typedef {object} StreetLevelHandlers
 * @property {() => void} [closeViewer] Close the embedded viewer.
 * @property {(mode: string) => void} [setRenderMode] Fit or fill the photo.
 * @property {(id: string) => void} [openPhoto] Open a remembered photo again.
 * @property {(id: string, options?: {pendingOnly?: boolean}) => void} [closePhoto] Close the photo whose card went.
 * @property {() => void} [withdrawPhoto] Close any photo, loading or not: something else was picked.
 * @property {() => void} [cancelDockedPhoto] Cancel and restore the dock's current photo.
 * @property {() => void} [stopPlayback] Stop a playing sequence, out of sight.
 */

/**
 * Street Level as its photo viewer (StreetLevelViewer.vue, on the photo's
 * card in Context) and the card render it. StreetLevelControls owns the
 * presentation (`presentStreetLevel()`), the viewer and EXPAND: it
 * publishes here and attaches the actions the views forward.
 */
export const useStreetLevelStore = defineStore('gev-street-level', () => {
  /** The presented row and viewer; null until an owner renders, then its last render. */
  const view = shallowRef(null);
  /** Whether EXPAND has the viewer full screen; null until first synced. */
  const expanded = shallowRef(null);
  /** False on a page with neither element fullscreen nor popovers. */
  const expandAvailable = shallowRef(true);
  /** Whether the photo is shown over the globe on an embedded page. */
  const embedOverlay = shallowRef(false);
  /** @type {{handlers: StreetLevelHandlers}|null} */
  let owner = null;

  /**
   * Attach the row and viewer actions for an owner, replacing any earlier owner.
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

  /** @param {boolean} on */
  function setEmbedOverlay(on) {
    embedOverlay.value = Boolean(on);
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
    return owner?.handlers[name]?.(...args);
  }

  return {
    view,
    expanded,
    expandAvailable,
    embedOverlay,
    attach,
    publish,
    setExpanded,
    setExpandAvailable,
    setEmbedOverlay,
    detach,
    act,
  };
});
