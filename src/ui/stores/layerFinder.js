import { defineStore } from 'pinia';
import { ref } from 'vue';
import { createLayerFinder } from '../layerFinderFilter.js';

/** Voice asks the Data Layers panel to reveal a filtered row before scrolling to it. */
export const LAYER_FINDER_CLEAR_EVENT = 'gev:layer-finder-clear';
export const useLayerFinderStore = defineStore('gev-layer-finder', () => {
  const finder = createLayerFinder();
  const controlsMounted = ref(false);
  let owner = null;

  function attachControls() {
    const mount = Symbol('Layer Finder controls');
    owner = mount;
    controlsMounted.value = true;
    return () => {
      if (owner !== mount) return;
      owner = null;
      controlsMounted.value = false;
      finder.clearAll();
    };
  }

  return { ...finder, controlsMounted, attachControls };
});
