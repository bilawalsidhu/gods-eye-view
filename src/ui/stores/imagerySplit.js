import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The before/after imagery dividers on the page, as their view renders them.
 * Each split (src/ui/imagerySplit.js) publishes its line under its own key
 * and withdraws it when destroyed; the view sends pointer and keyboard input
 * back to that split's controls.
 */
export const useImagerySplitStore = defineStore('gev-imagery-split', () => {
  /** The dividers in creation order: `{key, view, controls}`. */
  const splits = shallowRef([]);

  /**
   * Show or update one divider.
   * @param {number} key The split's own key.
   * @param {object} view A fresh presentation of its line.
   * @param {object} controls What the view calls for its input.
   */
  function publish(key, view, controls) {
    const entry = markRaw({ key, view, controls });
    const index = splits.value.findIndex((split) => split.key === key);
    splits.value =
      index < 0
        ? [...splits.value, entry]
        : splits.value.map((split, at) => (at === index ? entry : split));
  }

  /** @param {number} key The split to remove. */
  function withdraw(key) {
    splits.value = splits.value.filter((split) => split.key !== key);
  }

  return { splits, publish, withdraw };
});
