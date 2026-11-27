import { defineStore } from 'pinia';
import { nextTick, ref } from 'vue';
import { createPortalTargets } from '../portalTargets.js';

export const usePortalTargetsStore = defineStore('gev-portal-targets', () => {
  const version = ref(0);
  return createPortalTargets({
    read: () => version.value,
    changed: () => version.value++,
    // Keep the old offer available through the source's focus repair.
    afterMove: (clear) => nextTick(() => queueMicrotask(clear)),
  });
});
