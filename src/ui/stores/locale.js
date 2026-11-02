import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The interface language picker as its view renders it. The shell publishes
 * the active language and what a choice does once it decides to show the
 * picker; a host that does not initialize Core's locale never does.
 */
export const useLocaleStore = defineStore('gev-locale', () => {
  /** `{current, onSelect, focus}`, or null while no picker is shown. */
  const picker = shallowRef(null);

  /** @param {?{current: string, onSelect: (locale: string) => void, focus?: boolean}} next */
  function publishPicker(next) {
    picker.value = next && markRaw(next);
  }

  return { picker, publishPicker };
});
