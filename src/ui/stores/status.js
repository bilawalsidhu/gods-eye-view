import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The scene's status chips as their views render them. ShellFeedback
 * (src/ui/shellFeedback.js) publishes the top-center loading status and the
 * road network chip, CctvControls the camera grid chip. Each label keeps its
 * last text while hidden, so the next change flaps from what was shown.
 */
export const useStatusStore = defineStore('gev-status', () => {
  /**
   * `{hidden, state, label, detail, stopped}`; null until first published.
   * `stopped` rests a label for good once its owner is destroyed.
   */
  const loading = shallowRef(null);
  /** `{visible, label, immediate, progress, stopped}`, or null. */
  const traffic = shallowRef(null);
  /** `{visible, label, immediate, progress, stopped}`, or null. */
  const cctv = shallowRef(null);

  /** @param {?object} next A fresh presentation of the loading status. */
  function publishLoading(next) {
    loading.value = next && markRaw(next);
  }

  /** @param {?object} next A fresh presentation of the road network chip. */
  function publishTraffic(next) {
    traffic.value = next && markRaw(next);
  }

  /** @param {?object} next A fresh presentation of the camera grid chip. */
  function publishCctv(next) {
    cctv.value = next && markRaw(next);
  }

  return {
    loading,
    publishLoading,
    traffic,
    publishTraffic,
    cctv,
    publishCctv,
  };
});
