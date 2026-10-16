// One selection dispatcher for the layers that have moved onto the globe
// engine (phase 3 Task 4): one click subscription with picks
// (engine.input.on('click', …, { pick: true, drill: 8 })), the press
// gesture and one Escape listener, instead of a ScreenSpaceEventHandler
// per layer. Owners register as with pickRegistry (registerPickOwner, so
// layers still on their own handlers keep seeing the ownership) plus
// handlers:
//   onSelect(id, ctx)   a click whose first pick it owns;
//   onEmptyClick(ctx)   a clean click (short, no drag) on the map or nothing;
//   onEscape()          Escape.
// The rules are the old handlers': a pick another layer owns is not empty
// space; `passThrough` picks (trails) never take the click, the next pick
// does; a `drillThrough` owner (local ADS-B) takes its object from under
// another layer's; a drag selects nothing; a pointer owned by a tool
// (inputOwnership) selects nothing. Layers not moved yet keep their own
// handlers: the dispatcher never acts on an id it does not own.

import { isPointerFree as pointerFree } from './inputOwnership.js';
import {
  findPickOwner,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import {
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';

export const SELECTION_DRILL = 8;

/**
 * @param {import('../globe/contract.js').GlobeEngine} engine
 * @param {{ keyTarget?: EventTarget, now?: () => number, isPointerFree?: () => boolean }} [options]
 */
export function createSelectionDispatcher(
  engine,
  {
    keyTarget = globalThis.document,
    now = () => performance.now(),
    isPointerFree = pointerFree,
  } = {},
) {
  const owners = new Map();
  let removers = [];
  let destroyed = false;

  // The press gesture, as bindTrackingClickGesture measures it.
  let press = null;
  let completed = null;
  const travel = (position) => {
    if (!press || !position) return;
    if (press.last)
      press.travelPx += Math.hypot(
        position.x - press.last.x,
        position.y - press.last.y,
      );
    press.last = { x: position.x, y: position.y };
  };
  const finish = (position) => {
    if (!press) return;
    travel(position);
    completed = {
      travelPx: press.travelPx,
      durationMs: Math.max(0, now() - press.startedAt),
    };
    press = null;
  };

  const ownerOf = (picked) => {
    const id = resolvePickId(picked);
    if (id === null) return { id, owner: null };
    for (const [name, owner] of owners)
      if (safely(() => owner.owns(id))) return { id, owner: name };
    return { id, owner: findPickOwner(id) };
  };

  const onClick = (event) => {
    if (press) finish(event.position);
    const gesture = completed ?? { travelPx: 0, durationMs: 0 };
    completed = null;
    if (!isPointerFree()) return;
    const ctx = {
      position: event.position,
      picked: event.picked,
      drilled: event.drilled ?? [],
      gesture,
    };
    const candidates = [event.picked, ...(event.drilled ?? [])].filter(
      (picked) =>
        picked &&
        picked.id !== undefined &&
        ![...owners.values()].some((owner) =>
          safely(() => owner.passThrough?.(picked)),
        ),
    );
    // Drill results repeat the pick; keep the first of each id.
    const seen = new Set();
    const picks = candidates.filter((picked) => {
      const id = resolvePickId(picked);
      if (id === null || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!picks.length) {
      if (!isTrackingClickGesture(gesture)) return;
      for (const owner of [...owners.values()]) owner.onEmptyClick?.(ctx);
      return;
    }
    if (!isTrackingSelectionGesture(gesture)) return;
    const first = ownerOf(picks[0]);
    if (owners.has(first.owner)) {
      owners
        .get(first.owner)
        .onSelect?.(first.id, { ...ctx, picked: picks[0] });
      return;
    }
    // Another layer's object on top: a drill-through owner may still take
    // its own object from below.
    for (const picked of picks.slice(1)) {
      const below = ownerOf(picked);
      const owner = owners.get(below.owner);
      if (owner?.drillThrough) {
        owner.onSelect?.(below.id, { ...ctx, picked });
        return;
      }
    }
  };

  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    for (const owner of [...owners.values()]) owner.onEscape?.();
  };

  const attach = () => {
    if (removers.length || destroyed) return;
    removers = [
      engine.input.on('down', (event) => {
        press = {
          startedAt: now(),
          travelPx: 0,
          last: null,
        };
        completed = null;
        travel(event.position);
      }),
      engine.input.on('move', (event) => travel(event.endPosition)),
      engine.input.on('up', (event) => finish(event.position)),
      engine.input.on('click', onClick, { pick: true, drill: SELECTION_DRILL }),
    ];
    keyTarget?.addEventListener?.('keydown', onKey);
    removers.push(() => keyTarget?.removeEventListener?.('keydown', onKey));
  };
  const detach = () => {
    for (const remove of removers.splice(0)) remove();
  };

  return {
    /**
     * @param {string} name the owning layer's id
     * @param {{ owns: (id: string) => boolean, onSelect?: Function, onEmptyClick?: Function,
     *   onEscape?: Function, passThrough?: (picked: object) => boolean, drillThrough?: boolean }} owner
     * @returns {() => void} unregister
     */
    register(name, owner) {
      if (destroyed) return () => {};
      if (typeof owner?.owns !== 'function')
        throw new TypeError('A selection owner needs owns(id)');
      owners.set(name, owner);
      registerPickOwner(name, owner.owns);
      attach();
      return () => {
        if (owners.get(name) !== owner) return;
        owners.delete(name);
        unregisterPickOwner(name);
        if (!owners.size) detach();
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const name of owners.keys()) unregisterPickOwner(name);
      owners.clear();
      detach();
    },
  };
}

function safely(run) {
  try {
    return run();
  } catch {
    return false;
  }
}
