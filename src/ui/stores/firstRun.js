import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * The first-run mission launcher as the welcome view renders it.
 * initFirstRunExperience presents it and connects the controls its buttons
 * and checkbox call.
 */
export const useFirstRunStore = defineStore('gev-first-run', () => {
  /**
   * `{removed, shown, visible, closing, state, busy, status,
   * environmentalTitle, environmentalSub, scrollable}`, or null until the
   * launcher is initialized (the card stays hidden).
   */
  const [launcher, publish] = presented();

  /** `{choose(choice), dismiss(), suppress(wanted) → boolean, refreshLayout()}`, or null. */
  const [controls, connect] = presented();

  return { launcher, publish, controls, connect };
});
