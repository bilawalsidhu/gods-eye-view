/**
 * @module render/cesium/cameraInput
 * @description User camera input on a Cesium scene, suspended by counted
 * holds. Every suspender gets its own release, and input comes back when the
 * last one releases.
 *
 * The holds own the controller's `enableInputs`: what others write to it
 * (Cesium's own camera flights turn it off and back on) is kept, and it reads
 * true only while that is true and no hold is out, so a flight that ends can
 * no longer re-enable input under a drag or the cockpit.
 *
 * One set of holds per scene, shared by everyone who acquires it (the input
 * port, the camera port, the application's dispatcher); the controller gets
 * its own property back when the last of them releases.
 */

/** @type {WeakMap<object, {holds: Set<object>, users: number, restore: () => void}>} */
const shared = new WeakMap();

/**
 * Take over the controller's `enableInputs`: what others write to it is kept
 * (through an accessor already there, if any), and it reads true only while
 * that is true and no hold is out.
 * @param {object|undefined} controller
 * @param {Set<object>} holds
 * @returns {() => void} Gives the controller its own property back.
 */
function ownCameraInput(controller, holds) {
  if (!controller) return () => {};
  const own = Object.getOwnPropertyDescriptor(controller, 'enableInputs');
  if (own && !own.configurable) {
    console.warn('Camera input holds are unavailable: enableInputs is fixed');
    return () => {};
  }
  // A class may define it on its prototype; the hold shadows that for a while.
  let original = own;
  for (let proto = Object.getPrototypeOf(controller); !original && proto;) {
    original = Object.getOwnPropertyDescriptor(proto, 'enableInputs');
    proto = Object.getPrototypeOf(proto);
  }
  original ??= { value: true, writable: true, enumerable: true };
  let written = Boolean(original.get ? true : original.value);
  const read = () =>
    original.get ? Boolean(original.get.call(controller)) : written;
  Object.defineProperty(controller, 'enableInputs', {
    configurable: true,
    enumerable: original.enumerable ?? true,
    get: () => read() && holds.size === 0,
    set: (value) => {
      written = Boolean(value);
      original.set?.call(controller, value);
    },
  });
  return () => {
    delete controller.enableInputs;
    if (own?.get || own?.set)
      Object.defineProperty(controller, 'enableInputs', own);
    else if (own || !(original.get || original.set))
      controller.enableInputs = written;
  };
}

/**
 * A user of the scene's camera-input holds.
 * @typedef {object} CameraInput
 * @property {(reason: string) => () => void} suspend Hold camera input off;
 *   returns this hold's release (a second call does nothing).
 * @property {boolean} enabled False while any hold, anyone's, is out.
 * @property {() => string[]} reasons The reasons of every hold out.
 * @property {() => void} release Give back this user's holds, and the
 *   controller's property once no user is left.
 */

/**
 * @param {{screenSpaceCameraController?: object}} scene
 * @returns {CameraInput}
 */
export function acquireCameraInput(scene) {
  let state = shared.get(scene);
  if (!state) {
    const holds = new Set();
    state = {
      holds,
      users: 0,
      restore: ownCameraInput(scene.screenSpaceCameraController, holds),
    };
    shared.set(scene, state);
  }
  state.users += 1;
  const s = state;
  const mine = new Set();
  let released = false;
  return {
    suspend(reason) {
      if (released) return () => {};
      const hold = { reason: String(reason) };
      s.holds.add(hold);
      mine.add(hold);
      return () => {
        if (!mine.delete(hold)) return;
        s.holds.delete(hold);
      };
    },
    get enabled() {
      return s.holds.size === 0;
    },
    reasons: () => [...s.holds].map((hold) => hold.reason),
    release() {
      if (released) return;
      released = true;
      for (const hold of mine) s.holds.delete(hold);
      mine.clear();
      s.users -= 1;
      if (s.users > 0) return;
      s.restore();
      if (shared.get(scene) === s) shared.delete(scene);
    },
  };
}
