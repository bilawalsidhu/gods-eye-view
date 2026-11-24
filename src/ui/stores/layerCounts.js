import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

const emptySnapshot = () => ({ counts: {}, lastAttemptAt: null });

/** Keep Inspector totals and cooldown across controls using the same source. */
export const useLayerCountsStore = defineStore('gev-layer-counts', () => {
  const state = shallowRef(emptySnapshot());
  let sourceBinding;

  function bindSource(binding) {
    if (binding === sourceBinding) return;
    sourceBinding = binding;
    state.value = emptySnapshot();
  }

  function publish(next) {
    state.value = next;
  }

  return { state, bindSource, publish };
});
