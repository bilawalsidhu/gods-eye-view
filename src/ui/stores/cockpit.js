import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * Cockpit content as its views render it. The Cockpit controller presents
 * the briefing card's pages, cycle toggle, regional news and local
 * conditions, and the Contact card's readouts and weather toggle, and
 * publishes them here; it keeps the controls' listeners.
 */
export const useCockpitStore = defineStore('gev-cockpit', () => {
  /** The presented briefing; null until the controller first presents it. */
  const brief = shallowRef(null);

  /** @param {?object} next A fresh presentation of the briefing card. */
  function publishBrief(next) {
    brief.value = next && markRaw(next);
  }

  /** The presented Contact card; null until the controller first presents it. */
  const context = shallowRef(null);

  /** @param {?object} next A fresh presentation of the Contact card. */
  function publishContext(next) {
    context.value = next && markRaw(next);
  }

  return { brief, publishBrief, context, publishContext };
});
