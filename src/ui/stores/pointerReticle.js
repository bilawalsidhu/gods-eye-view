import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The voice pointer reticles as their view renders them. Each PointerReticle
 * (src/voice/pointerReticle.js) presents where the user pointed while its
 * voice turn is live.
 */
export const usePointerReticleStore = defineStore('gev-pointer-reticle', () => {
  /**
   * `[{owner, visible, left, top, target}]` in client pixels, one per
   * reticle that has shown, `target` being 'entity' or 'ground'.
   */
  const reticles = shallowRef([]);

  /**
   * @param {object} owner The reticle publishing.
   * @param {?object} view Its fresh presentation, or null to remove it.
   */
  function publish(owner, view) {
    const index = reticles.value.findIndex((item) => item.owner === owner);
    const next = reticles.value.slice();
    if (!view) {
      if (index < 0) return;
      next.splice(index, 1);
    } else if (index < 0) next.push(markRaw({ ...view, owner }));
    else next[index] = markRaw({ ...view, owner });
    reticles.value = next;
  }

  return { reticles, publish };
});
