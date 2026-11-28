import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * The interface language picker as its view renders it. The shell publishes
 * the active language and what a choice does once it decides to show the
 * picker; a host that does not initialize Core's locale never does.
 */
export const useLocaleStore = defineStore('gev-locale', () => {
  /** `{current, onSelect, focus}`, or null while no picker is shown. */
  const [picker, publishPicker] = presented();

  return { picker, publishPicker };
});
