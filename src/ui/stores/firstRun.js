import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The first-run mission launcher as the welcome view renders it.
 * initFirstRunExperience presents it and connects the controls its buttons
 * and checkbox call.
 */
export const useFirstRunStore = defineStore('gev-first-run', () => {
  /**
   * `{removed, shown, visible, closing, state, busy, status, description,
   * environmentalTitle, environmentalSub, scrollable}`, or null until the
   * launcher is initialized (the card stays hidden).
   */
  const launcher = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    launcher.value = next && markRaw(next);
  }

  /** `{choose(choice), dismiss(), suppress(wanted) → boolean}`, or null. */
  const controls = shallowRef(null);

  /** @param {?object} next The launcher's controls, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  return { launcher, publish, controls, connect };
});
