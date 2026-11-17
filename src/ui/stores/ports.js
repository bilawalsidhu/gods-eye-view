import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { createOwners } from './owners.js';

/** Port reference panel state and caller-owned controls. */
export const usePortsStore = defineStore('gev-ports', () => {
  const panel = shallowRef(null);
  const collapsed = ref(false);
  const owners = createOwners();
  return {
    panel,
    collapsed,
    publish: (next) => {
      panel.value = next;
      if (!next) collapsed.value = false;
    },
    connect: owners.connect,
    detach: owners.detach,
    act: owners.act,
  };
});
