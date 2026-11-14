import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { createOwners } from './owners.js';
import { normalizeVesselFilters } from '../../data/vesselDisplayFilters.js';

export const useVesselPanelStore = defineStore('gev-vessel-panel', () => {
  const owners = createOwners();
  const visible = ref(false);
  const available = ref(false);
  const enabled = ref(false);
  const filters = shallowRef(normalizeVesselFilters());
  const list = shallowRef({
    rows: [],
    total: 0,
    matching: 0,
    page: 0,
    pages: 1,
  });
  const search = ref('');
  const error = ref('');
  async function act(name, ...args) {
    error.value = '';
    if (name === 'visibility') visible.value = Boolean(args[0]);
    try {
      return await owners.act(name, ...args);
    } catch (failure) {
      error.value = failure.message;
    }
  }
  return {
    visible,
    available,
    enabled,
    filters,
    list,
    search,
    error,
    act,
    connect: owners.connect,
    detach: owners.detach,
  };
});
