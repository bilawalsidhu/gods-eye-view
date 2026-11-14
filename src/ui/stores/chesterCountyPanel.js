import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { createOwners } from './owners.js';

/** Presentation and actions for the enabled county incident app. */
export const useChesterCountyPanelStore = defineStore(
  'gev-chester-county-panel',
  () => {
    const owners = createOwners();
    const view = shallowRef(null);
    const error = ref('');
    async function act(name, ...args) {
      error.value = '';
      try {
        return await owners.act(name, ...args);
      } catch (failure) {
        error.value = failure.message;
        return false;
      }
    }
    return {
      view,
      error,
      publish(next) {
        view.value = next;
      },
      act,
      connect: owners.connect,
      detach: owners.detach,
      owns: owners.owns,
    };
  },
);
