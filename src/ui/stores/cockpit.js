import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * Cockpit content as its views render it. The Cockpit controller presents
 * the briefing card's pages, cycle toggle, regional news and local
 * conditions, the Contact card's readouts and weather toggle, the
 * instruments, the flight plan, the vision selector and the signal rows,
 * and publishes them
 * here; it keeps the controls' listeners.
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

  /** The presented instruments; null until the first HUD update. */
  const instruments = shallowRef(null);

  /** @param {?object} next A fresh presentation of the instruments. */
  function publishInstruments(next) {
    instruments.value = next && markRaw(next);
  }

  /** The presented flight plan and destination arrow; null until the first. */
  const route = shallowRef(null);

  /** @param {?object} next A fresh presentation of the route. */
  function publishRoute(next) {
    route.value = next && markRaw(next);
  }

  /** The presented vision selector; null until the first vision change. */
  const vision = shallowRef(null);

  /** @param {?object} next A fresh presentation of the vision selector. */
  function publishVision(next) {
    vision.value = next && markRaw(next);
  }

  /** The presented signal rows; null until the controller first presents them. */
  const signals = shallowRef(null);

  /** @param {?object[]} next A fresh presentation of the signal rows. */
  function publishSignals(next) {
    signals.value = next && markRaw(next);
  }

  return {
    brief,
    publishBrief,
    context,
    publishContext,
    instruments,
    publishInstruments,
    route,
    publishRoute,
    vision,
    publishVision,
    signals,
    publishSignals,
  };
});
