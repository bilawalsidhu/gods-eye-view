// A globe engine for the Cockpit (src/ui/cockpitHost.js): the fake engine,
// and aircraft its follow rides the way it rides the aircraft display's
// tracked glyphs (src/layers/aircraft/render/display.js): the follow's
// `native` is the glyph handle, with `live`, `show`, `spec.position()` and
// `resumeAircraftFollow()`.
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

const VIEW_FROM = Object.freeze({ x: 0, y: -2400, z: 1650 });

/**
 * @param {Parameters<typeof createFakeEngine>[0]} [options]
 */
export function createCockpitEngine(options) {
  const engine = createFakeEngine(options);
  const follow = (target) =>
    engine.camera.follow({
      native: target,
      position: () => target.spec.position(),
      viewFrom: VIEW_FROM,
    });
  return {
    engine,
    /**
     * A tracked aircraft glyph at `position` (a Cartesian3, or none); the
     * other fields (gevTrackedId…) are copied on.
     */
    aircraft({ position = null, ...fields } = {}) {
      const target = {
        live: true,
        show: true,
        spec: { position: () => position },
        ...fields,
      };
      target.resumeAircraftFollow = () => {
        follow(target);
      };
      return target;
    },
    /** Follow `target`, as its layer tracking it does: followChanged fires. */
    ride(target) {
      follow(target);
      return target;
    },
    /** The followed aircraft, or null. */
    following: () => engine.camera.following()?.native ?? null,
  };
}
