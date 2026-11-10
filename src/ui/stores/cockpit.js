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
   * The orbital view's HUD: null outside a satellite subject. Shape:
   * `{ name, classLabel, altitudeM, velocityMps|null, latitude, longitude,
   *    zoom, zoomSteps: number[], maxZoom, footprintKm|null,
   *    sensor: { label|null, swathKm, stripFraction|null, zoom|null }|null,
   *    transition: { active, blurPx, lockTick },
   *    look: { offset, readout, swathScale, swathKm|null,
   *      focus: { key, label }|null }, trackUp, northDeg,
   *    place: { kind: 'country'|'sea'|'ocean', name, countryCode,
   *      division?|null, near?|null }|null|undefined,
   *    noradId|null, cosparId|null, tle: { line1, line2, epochMs }|null,
   *    tleAgeMs|null (now minus the TLE epoch, read on each publish),
   *    owner: { countryCode|null, label|null }|null, operator|null }` where
   * `place` is what the sub-satellite point is over (undefined until the
   * first offline lookup lands, null when nothing named holds it; see
   * src/data/placeBelow.js), the identity fields come from the satellites
   * layer and are null when unknown, `classLabel` is
   * already localized (the satellite layer's class label, e.g. "NAV · GPS"),
   * `velocityMps` is the orbital (inertial) speed, latitude/longitude are the
   * sub-satellite point in degrees, `zoom` is one of `zoomSteps` (1, 2, 4, 8,
   * and up to 128 for an imaging satellite with a known sensor: `maxZoom`) or
   * the SENSOR step's zoom between them, `sensor` is the imaging sensor's
   * narrowest swath with the fraction of the view it spans (kept off nadir)
   * and the zoom that frames it (null when outside 1x..maxZoom),
   * `footprintKm` is the nadir ground width across the frame at that zoom
   * (null while the view is tilted off nadir), `transition` is a zoom step in
   * flight: `active` while the field of view moves, `blurPx` the focus-pull
   * blur for the picture, `lockTick` true briefly once the step settles (see
   * src/cockpitOrbital.js), `look` says whether the view is tilted off
   * nadir and words the tilt (`readout`, '' at nadir), with the approximate
   * ground width at the tilted view's centre (`swathKm`, null at nadir) and
   * its ratio to the nadir footprint (`swathScale`, 1 at nadir) and the
   * mapped point a ground focus holds the view on (`focus`; the readout
   * then gives the single off-nadir angle to it), `trackUp`
   * whether the view is turned to the ground track (false for a satellite with none,
   * which stays north-up) and `northDeg` where north sits, in degrees
   * clockwise from the top (0 when north-up).
   */
  const orbital = shallowRef(null);

  /** @param {?object} next A fresh presentation of the orbital view HUD. */
  function publishOrbital(next) {
    orbital.value = next && markRaw(next);
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
    orbital,
    publishOrbital,
    utilityLayout,
    publishUtilityLayout,
  };
});
