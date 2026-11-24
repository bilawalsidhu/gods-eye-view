import { defineStore } from 'pinia';
import { computed, reactive, ref, shallowRef } from 'vue';
import { createLayerFinder, finderForLayerRows } from '../layerFinderFilter.js';

export const useLayerFinderStore = defineStore('gev-layer-finder', () => {
  const finder = createLayerFinder();
  const controlsMounted = ref(false);
  const controlList = shallowRef(null);
  const activeFinder = computed(() =>
    reactive(finderForLayerRows(controlList.value) ?? finder),
  );
  let owner = null;

  function attachControls(list = null) {
    const mount = Symbol();
    owner = mount;
    controlList.value = list;
    controlsMounted.value = true;
    return () => {
      if (owner !== mount) return;
      owner = null;
      controlList.value = null;
      controlsMounted.value = false;
      finder.clearAll();
    };
  }

  return { ...finder, controlsMounted, activeFinder, attachControls };
});
