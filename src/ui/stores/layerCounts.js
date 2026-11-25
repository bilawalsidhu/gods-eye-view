import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

const emptySnapshot = () => ({ counts: {}, lastAttemptAt: null });

/** Keep Inspector totals and cooldown across Inspector mounts. */
export const useLayerCountsStore = defineStore('gev-layer-counts', () => {
  const state = shallowRef(emptySnapshot());
  function publish(next) {
    state.value = next;
  }

  return { state, publish };
});
