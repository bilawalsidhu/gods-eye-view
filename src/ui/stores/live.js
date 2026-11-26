import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';
import { createOwners } from './owners.js';

/**
 * The LIVE section in Context as its view renders it: the streams on offer
 * for the selected object, the one chosen and the player's state.
 * LiveControls presents it (`gev-live` store) and answers the section's
 * controls through act(): `cycleLive`, `playLive`, `stopLive`, `retryLive`.
 */
export const useLiveStore = defineStore('gev-live', () => {
  /** The presented section; null while nothing selected has a stream. */
  const view = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  const { connect, detach, act } = createOwners();

  return { view, publish, connect, detach, act };
});
