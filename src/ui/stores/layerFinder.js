import { defineStore } from 'pinia';
import { computed, shallowRef } from 'vue';
import { bindLayerFinder, createLayerFinder } from '../layerFinderFilter.js';

export const useLayerFinderStore = defineStore('gev-layer-finder', () => {
  const finder = createLayerFinder();
  const owner = shallowRef(null);
  const controlsMounted = computed(() => owner.value !== null);

  function attachControls(list = null) {
    const mount = Symbol();
    owner.value = mount;
    const unbind = list && bindLayerFinder(list, finder);
    return () => {
      unbind?.();
      if (owner.value !== mount) return;
      owner.value = null;
      finder.clearAll();
    };
  }

  return { ...finder, controlsMounted, attachControls };
});
