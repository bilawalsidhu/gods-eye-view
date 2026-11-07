import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * Cockpit content as its views render it. The Cockpit controller presents
 * which Cockpit surfaces are shown, the briefing card's pages, cycle toggle, regional news and local
 * conditions, the Contact card's readouts and weather toggle, the
 * instruments, the flight plan, the vision selector and the signal rows,
 * and publishes them
 * here; it keeps the controls' listeners.
 */
export const useCockpitStore = defineStore('gev-cockpit', () => {
  /** Which Cockpit surfaces are shown; null until the controller first syncs. */
  const presence = shallowRef(null);

  /** @param {?object} next A fresh presentation of the shown surfaces. */
  function publishPresence(next) {
    presence.value = next && markRaw(next);
  }

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

  /**
   * The presented instruments; null until the first HUD update. Besides the
   * readouts, `look: { offset, yawDeg, readout }` says whether a bridge view
   * is turned off the bow, the yaw it is turned to (degrees in -180..180,
   * starboard positive; the radar draws its look line there) and the worded
   * readout. An aircraft's look always rests (`offset: false`).
   */
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

  /**
   * The bridge radar: null outside a vessel bridge. Shape:
   * `{ rangeNm, rangeLabel, ringsNm: number[], headingDeg,
   *    ownRelativeCourseDeg|null,
   *    contacts: [{ id, name, x, y, distanceNm, relativeBearingDeg,
   *    relativeCourseDeg|null, color, stale }] }` where x/y are heading-up
   * screen fractions in [-1, 1] (x right, y up) of the range circle.
   */
  const radar = shallowRef(null);

  /** @param {?object} next A fresh presentation of the bridge radar. */
  function publishRadar(next) {
    radar.value = next && markRaw(next);
  }

  /**
   * The utility strip's measured layout: its top and height limits as CSS
   * lengths (null leaves the stylesheet's), whether only the expanded control
   * fits, and whether a collapsed control beside an expanded one is hidden
   * from assistive technology. Null until the first layout pass.
   */
  const utilityLayout = shallowRef(null);

  /** @param {?object} next A fresh layout; one equal to the current is dropped. */
  function publishUtilityLayout(next) {
    const current = utilityLayout.value;
    if (
      next &&
      current &&
      Object.keys(next).every((key) => next[key] === current[key])
    )
      return;
    utilityLayout.value = next && markRaw(next);
  }

  return {
    presence,
    publishPresence,
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
    radar,
    publishRadar,
    utilityLayout,
    publishUtilityLayout,
  };
});
