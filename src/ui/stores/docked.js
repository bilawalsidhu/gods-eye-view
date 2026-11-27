import { defineStore } from 'pinia';
import { ref } from 'vue';

// Docked: one live view kept on screen while other things are
// inspected, bottom right, above the radio mini player. A camera's feed or a
// street-level photo docks from its card's Dock button, a flight's cockpit
// view from the small ⧉ on its card's top image.
// Docking another view replaces it; docking never pins (Pinned is its own
// list, stores/pinned.js).

/**
 * @typedef {{key: string, kind: 'camera'|'cockpit'|'street', title: string,
 *   identity: {layerId: string, id: string, label?: string, lat?: number, lon?: number}}} DockedItem
 */

export const useDockedStore = defineStore('docked', () => {
  /** @type {import('vue').Ref<DockedItem|null>} */
  const view = ref(null);

  /** Dock a view, replacing any docked one. */
  function dock(next) {
    if (!next?.key || !['camera', 'cockpit', 'street'].includes(next.kind))
      return;
    view.value = { ...next, identity: { ...next.identity } };
  }
  function close() {
    view.value = null;
    feed.value = { key: '', dot: '', text: '' };
  }
  /**
   * How live the docked view is, as the dock itself shows it (DockedView.vue
   * publishes it): its FeedDot state ('live', 'loading', 'paused', 'lost')
   * and its wording ("Docked · stalled"). A docked camera's pin and its
   * card's Docked bar read it, so neither says "live" over a stalled or
   * failed stream.
   */
  const feed = ref({ key: '', dot: '', text: '' });
  function setFeed(key, dot, text) {
    if (!key || !isDocked(key)) return;
    if (
      feed.value.key === key &&
      feed.value.dot === dot &&
      feed.value.text === text
    )
      return;
    feed.value = { key, dot, text };
  }
  /** The docked view's feed state, or null when it is not docked or not yet shown. */
  const feedOf = (key) =>
    key && isDocked(key) && feed.value.key === key ? feed.value : null;
  /**
   * The last frame a docked camera showed before its layer went off, kept
   * after the dock closes so its card can show it (one at a time).
   */
  const lastStill = ref({ key: '', url: '' });
  function keepStill(key, url) {
    if (key && url) lastStill.value = { key, url };
  }
  const lastStillOf = (key) =>
    key && lastStill.value.key === key ? lastStill.value.url : '';
  const isDocked = (key) => view.value?.key === key;
  /**
   * True while Context is the full-height column over the corner: the dock
   * is hidden and paused (no stream of its own, no painting, no frame
   * reads), and shows again, live, once Context shrinks or folds. Docking,
   * closing and what is docked do not change.
   */
  const stowed = ref(false);
  function setStowed(next) {
    stowed.value = Boolean(next);
  }
  /** Dock it, or close the dock when it is the one docked. */
  function toggle(next) {
    if (next && isDocked(next.key)) close();
    else dock(next);
  }

  return {
    view,
    dock,
    close,
    isDocked,
    toggle,
    keepStill,
    lastStillOf,
    feed,
    setFeed,
    feedOf,
    stowed,
    setStowed,
  };
});
