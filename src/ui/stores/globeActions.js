import { defineStore } from 'pinia';
import { ref } from 'vue';
import { createOwners } from './owners.js';

/**
 * The top-center globe actions as their view renders them. The shell
 * publishes whether a clear of the selected data layers is under way, and
 * answers the clear and share buttons through act().
 */
export const useGlobeActionsStore = defineStore('gev-globe-actions', () => {
  /** Whether a clear is under way; null until the shell first says. */
  const clearBusy = ref(null);

  /** @param {boolean | null} busy null when no shell answers the clear. */
  function publishClearBusy(busy) {
    clearBusy.value = busy == null ? null : Boolean(busy);
  }

  const { connect, detach, act } = createOwners();

  return { clearBusy, publishClearBusy, connect, detach, act };
});
