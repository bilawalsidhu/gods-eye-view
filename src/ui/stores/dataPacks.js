import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The loaded data packs' attribution cards as their view renders them. Each
 * set of data-pack presentations (src/scenes/dataPacks/presentation.js)
 * presents its own panel, with a card for each pack and its media player
 * when the pack is media.
 */
export const useDataPacksStore = defineStore('gev-data-packs', () => {
  /**
   * `[{owner, key, container, cards: [{key, id, title, url, media}]}]`, one
   * per owner showing cards. `container` is the element the panel sits in;
   * `media` is `{kind: 'video'|'audio', src}` or null.
   */
  const panels = shallowRef([]);

  /**
   * @param {object} owner The presentations publishing.
   * @param {?object} panel Their fresh panel, or null to remove it.
   */
  function publish(owner, panel) {
    const index = panels.value.findIndex((item) => item.owner === owner);
    const next = panels.value.slice();
    if (!panel) {
      if (index < 0) return;
      next.splice(index, 1);
    } else if (index < 0) next.push(markRaw({ ...panel, owner }));
    else next[index] = markRaw({ ...panel, owner });
    panels.value = next;
  }

  return { panels, publish };
});
