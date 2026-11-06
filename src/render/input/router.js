/**
 * @module render/input/router
 * @description Who hears each pointer event: the contract's input rules
 * (`src/render/contract/input.d.ts`) for any renderer. A renderer feeds it
 * the events its engine sees, already shaped as `PointerEv` (its clicks with
 * their pick); the router decides, from the leases and the presses under
 * way, which listeners get each one, and keeps the input port's leases and
 * behaviour holds. Engine-free.
 */

const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= 4;

/**
 * @param {object} options
 * @param {(error: unknown) => void} options.report Where a listener's or a
 *   `grab`'s error goes.
 * @param {(reason: string) => () => void} options.suspendCamera The
 *   renderer's counted camera-input hold.
 * @param {string[]} [options.behaviours] The stock behaviours the renderer
 *   has, beyond `select` and `dblclickFollow` (always listed).
 * @param {(name: string, enabled: boolean) => void} [options.onBehaviour]
 *   Told when a behaviour turns off (first hold) or back on (last release).
 * @param {(enabled: boolean) => void} [options.onCtrlWheelZoom] Told when
 *   `ctrlWheelZoom` is set.
 * @param {Record<string, boolean>} [options.supported] Behaviours the
 *   renderer cannot do, as `false`: listed, but reported disabled.
 */
export function createInputRouter({
  report,
  suspendCamera,
  behaviours: extra = [],
  onBehaviour = () => {},
  onCtrlWheelZoom = () => {},
  supported = {},
}) {
  const listeners = [];
  let currentLease = null;

  const holds = {};
  // The renderer hears a behaviour turn off and on only if it has it; its
  // error is reported, and the hold stands either way.
  const tell = (name, enabled) => {
    if (supported[name] === false) return;
    try {
      onBehaviour(name, enabled);
    } catch (error) {
      report(error);
    }
  };
  function makeBehaviour(name) {
    holds[name] = 0;
    return Object.freeze({
      get enabled() {
        return supported[name] !== false && holds[name] === 0;
      },
      suppress() {
        holds[name] += 1;
        if (holds[name] === 1) tell(name, false);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          holds[name] -= 1;
          if (holds[name] === 0) tell(name, true);
        };
      },
    });
  }
  const behaviours = Object.freeze(
    Object.fromEntries(
      ['select', 'dblclickFollow', ...extra].map((name) => [
        name,
        makeBehaviour(name),
      ]),
    ),
  );

  /** Each lease's `grab`, or null when it takes every press. */
  const leaseGrab = new WeakMap();
  /**
   * The presses under way, by button, from their `down`: `owner` is the
   * lease each went to, or null when it went to everyone else. A press's
   * click and double-click go where its down went (an ended owner's to no
   * one).
   */
  const presses = new Map();

  const leaseOf = (entry) =>
    typeof entry.lease === 'function' ? entry.lease() : entry.lease;

  let ctrlWheelZoom = false;
  const port = {
    on(type, cb, opts = {}) {
      const entry = { type, cb, lease: opts.lease ?? null, live: true };
      listeners.push(entry);
      return () => {
        entry.live = false;
        const i = listeners.indexOf(entry);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    claimPointer(owner, opts = {}) {
      if (currentLease) currentLease.release();
      let released = false;
      const grab = typeof opts.grab === 'function' ? opts.grab : null;
      const lease = {
        owner: String(owner),
        get current() {
          return !released && currentLease === lease;
        },
        release() {
          if (released) return;
          released = true;
          if (currentLease === lease) currentLease = null;
        },
      };
      currentLease = lease;
      leaseGrab.set(lease, grab);
      return lease;
    },
    isPointerFree: () => currentLease === null,
    suspendCameraControls: (reason) => suspendCamera(String(reason)),
    behaviours,
    get ctrlWheelZoom() {
      return ctrlWheelZoom;
    },
    set ctrlWheelZoom(value) {
      ctrlWheelZoom = Boolean(value);
      onCtrlWheelZoom(ctrlWheelZoom);
    },
  };

  /** Who a new press belongs to, decided from its `down`. */
  function pressFor(down) {
    const lease = currentLease;
    if (!lease) return { owner: null, clicked: false };
    const grab = leaseGrab.get(lease);
    let grabbed = !grab;
    if (grab)
      try {
        grabbed = grab(down) === true;
      } catch (error) {
        report(error);
      }
    return { owner: grabbed ? lease : null, clicked: false };
  }

  /**
   * Where an event goes: to one lease's listeners (`lease`), to everyone
   * without a lease (`ambient`), or both (`move` and `up`).
   */
  function recipients(ev) {
    const { type, button } = ev;
    // A click comes straight after its press's up, and a double-click
    // straight after that click, by the same button at the same spot;
    // anything else after the up ends the press.
    for (const [b, p] of presses) {
      if (!p.up) continue;
      const continues =
        b === button &&
        near(p.at, ev.position) &&
        ((type === 'click' && !p.clicked) ||
          (type === 'dblclick' && p.clicked));
      if (!continues) presses.delete(b);
    }
    if (type === 'up' && presses.has(button)) {
      const p = presses.get(button);
      p.up = true;
      p.at = ev.position;
    }
    if (type === 'move' || type === 'up')
      return { lease: currentLease, ambient: true };
    if (type === 'wheel' || type === 'pinch') {
      const exclusive = currentLease && !leaseGrab.get(currentLease);
      return exclusive
        ? { lease: currentLease, ambient: false }
        : { lease: null, ambient: true };
    }
    // `grab` sees a click with no press of its own as the down it stands
    // for: no pick, no gesture.
    const asDown = () => ({
      ...pressFor({
        type: 'down',
        position: ev.position,
        button: ev.button,
        modifiers: ev.modifiers,
        timestamp: ev.timestamp,
        pointerType: ev.pointerType,
      }),
      up: true,
    });
    let current;
    if (type === 'down') {
      current = pressFor(ev);
      presses.set(button, current);
    } else {
      // Only a press the loop above kept, at the right step, continues;
      // anything else is a press of its own and leaves a held one alone.
      const held = presses.get(button);
      const continues =
        held?.up && (type === 'click' ? !held.clicked : held.clicked);
      current = continues ? held : asDown();
      if (type === 'click' && (continues || !held)) {
        current.clicked = true;
        presses.set(button, current);
      } else if (continues) presses.delete(button);
    }
    current.at = ev.position;
    return current.owner
      ? { lease: current.owner, ambient: false }
      : { lease: null, ambient: true };
  }

  /**
   * Delivers one event to the listeners it belongs to.
   * @param {import('../contract/input').PointerEv} ev
   * @param {(to: {lease: object|null, ambient: boolean}) => void} [before]
   *   Runs first with who the event goes to: a renderer's stock behaviours,
   *   which run ahead of the subscribers. Its error is reported.
   * @returns {{lease: object|null, ambient: boolean}} Who it went to. A
   *   `move` or `up` always reads as going to both, grabbed press or not.
   */
  function dispatch(ev, before) {
    const to = recipients(ev);
    if (before)
      try {
        before(to);
      } catch (error) {
        report(error);
      }
    for (const entry of listeners.slice()) {
      if (!entry.live || entry.type !== ev.type) continue;
      if (entry.lease) {
        const lease = leaseOf(entry);
        if (!to.lease || lease !== to.lease || !lease.current) continue;
      } else if (!to.ambient) continue;
      try {
        entry.cb(ev);
      } catch (error) {
        report(error);
      }
    }
    return to;
  }

  return {
    port,
    dispatch,
    /** Live listeners, for leak checks. */
    listenerCount: () => listeners.length,
    /**
     * Ends delivery: no listener runs again, even for the event under way
     * (a listener that destroys the renderer stops the rest).
     */
    dispose() {
      for (const entry of listeners) entry.live = false;
      listeners.length = 0;
      currentLease?.release();
    },
  };
}
