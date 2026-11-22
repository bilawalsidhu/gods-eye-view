import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

/** Saved Inspector totals and cooldown survive controls replacement on this app. */
export const useLayerCountsStore = defineStore('gev-layer-counts', () => {
  const state = shallowRef({ counts: {}, lastAttemptAt: null });

  function publish(next) {
    state.value = next;
  }

  return { state, publish };
});
