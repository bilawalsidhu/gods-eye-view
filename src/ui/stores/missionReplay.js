import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Space Missions replay vehicle overlay as its view renders it. The
 * launches layer presents it through `subscribeReplayOverlay()` and the
 * application shell publishes each presentation here.
 */
export const useMissionReplayStore = defineStore('gev-mission-replay', () => {
  /**
   * `{visible, mode, thrusting, paused, transform, rotation, iconOpacity,
   * labelOpacity, title, detail}`, or null while the layer has no overlay.
   */
  const overlay = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    overlay.value = next && markRaw(next);
  }

  return { overlay, publish };
});
