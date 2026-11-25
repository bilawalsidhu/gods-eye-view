import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bindLayerFinder, createLayerFinder } from '../layerFinderFilter.js';

export const useLayerFinderStore = defineStore('gev-layer-finder', () => {
  const finder = createLayerFinder();
  const controlsMounted = ref(false);
  let owner = null;

  function attachControls(list = null) {
    const mount = Symbol();
    owner = mount;
    const unbind = list && bindLayerFinder(list, finder);
    controlsMounted.value = true;
    return () => {
      unbind?.();
      if (owner !== mount) return;
      owner = null;
      controlsMounted.value = false;
      finder.clearAll();
    };
  }

  return { ...finder, controlsMounted, attachControls };
});
