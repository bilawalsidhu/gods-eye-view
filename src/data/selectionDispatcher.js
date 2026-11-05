import { nearbyContact } from './pickRegistry.js';
// One selection dispatcher for the layers that draw through the globe
// engine: one click subscription with picks
// (engine.input.on('click', …, { pick: true, drill: 8 })), the press
// gesture and one Escape listener, instead of a ScreenSpaceEventHandler
// per layer. Owners register as with pickRegistry (registerPickOwner, so
// layers still on their own handlers keep seeing the ownership) plus
// handlers:
//   onSelect(id, ctx)   a click whose first pick it owns;
//   onEmptyClick(ctx)   a clean click (short, no drag) on the map or nothing;
//   onEscape()          Escape.
// The rules are the old handlers': a pick another layer owns is not empty
// space (a pick nobody owns is); `passThrough` picks (trails) never take the
// click, the next pick does; a `drillThrough` owner takes its object from
// under another layer's; a drag selects nothing; a pointer owned by a tool
// (inputOwnership) selects nothing. Layers not moved yet keep their own
// handlers: the dispatcher never acts on an id it does not own.
// A `lookUnder` owner (local ADS-B) keeps its own old click rule instead:
// its object on top, or under picks no layer owns and picks it looks under
// (`lookUnder(id)`: trails), is selected; another layer's object on top, or
// nothing, is empty space for it (it releases its selection); a click that
// only meets what it looks under does nothing; no gesture rule (its old
// handler took every click). To the others it is another layer.
// An own-rule owner (`onClick(ctx)`: vessels) keeps its whole old click
// handler: it gets every click with the top pick and decides itself (no
// gesture rule, as its old LEFT_CLICK handler); to the others it is another
// layer.

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

const SELECTION_DRILL = 8;

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

  // The look-under rule (local ADS-B's old click handler, kept as is).
  const lookUnderTarget = (name, owner, event) => {
    const ownedElsewhere = (id) => {
      if (id === null) return false;
      for (const [other, entry] of owners)
        if (other !== name && safely(() => entry.owns(id))) return true;
      const found = findPickOwner(id);
      return found !== null && found !== undefined && found !== name;
    };
    const mine = (id) => id !== null && safely(() => owner.owns(id));
    const under = (id) => id !== null && safely(() => owner.lookUnder(id));
    const top = resolvePickId(event.picked);
    if (mine(top)) return { id: top, picked: event.picked };
    const lookedUnder = under(top);
    if (ownedElsewhere(top) && !lookedUnder) return 'other';
    for (const hit of event.drilled ?? []) {
      const id = resolvePickId(hit);
      if (mine(id)) return { id, picked: hit };
      if (under(id)) continue;
      if (ownedElsewhere(id)) return 'other';
    }
    return lookedUnder ? 'under' : null;
  };
  const ownRule = (owner) => typeof owner.onClick === 'function';
  const plain = (owner) =>
    typeof owner.lookUnder !== 'function' && !ownRule(owner);

  const onClick = (event) => {
    if (press) finish(event.position);
    const gesture = completed ?? { travelPx: 0, durationMs: 0 };
    completed = null;
    if (!isPointerFree()) return;
    const picked = nearbyContact(
      event.picked,
      event.position,
      engine.picker?.drillPick,
    );
    if (picked !== event.picked) event = { ...event, picked };
    const ctx = {
      position: event.position,
      picked: event.picked,
      drilled: event.drilled ?? [],
      gesture,
    };
    for (const [name, owner] of [...owners]) {
      if (plain(owner)) continue;
      if (ownRule(owner)) {
        // Its old handler ran alone: a throw there leaves the others be.
        try {
          owner.onClick(ctx);
        } catch (error) {
          console.error(error);
        }
        continue;
      }
      const target = lookUnderTarget(name, owner, event);
      if (target === 'under') continue;
      if (target && target !== 'other')
        owner.onSelect?.(target.id, { ...ctx, picked: target.picked });
      else owner.onEmptyClick?.(ctx);
    }
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
      for (const owner of [...owners.values()].filter(plain))
        owner.onEmptyClick?.(ctx);
      return;
    }
    if (!isTrackingSelectionGesture(gesture)) return;
    const first = ownerOf(picks[0]);
    if (owners.has(first.owner)) {
      const owner = owners.get(first.owner);
      if (plain(owner))
        owner.onSelect?.(first.id, { ...ctx, picked: picks[0] });
      return;
    }
    // Another layer's object on top: a drill-through owner may still take
    // its own object from below.
    for (const picked of picks.slice(1)) {
      const below = ownerOf(picked);
      const owner = owners.get(below.owner);
      if (owner?.drillThrough && plain(owner)) {
        owner.onSelect?.(below.id, { ...ctx, picked });
        return;
      }
    }
    // A pick no layer owns (an unclaimed entity) is empty space, as it was
    // for the old handlers: only another layer's object is not.
    if (first.owner === null && isTrackingClickGesture(gesture))
      for (const owner of [...owners.values()].filter(plain))
        owner.onEmptyClick?.(ctx);
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
     *   onEscape?: Function, passThrough?: (picked: object) => boolean, drillThrough?: boolean,
     *   lookUnder?: (id: string) => boolean, onClick?: (ctx: object) => void }} owner
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

const dispatchers = new WeakMap();

/**
 * The application's one dispatcher for `engine`, created on first use (the
 * layers that moved onto the engine share it).
 * @param {import('../globe/contract.js').GlobeEngine} engine
 */
export function selectionDispatcherFor(engine) {
  if (!engine) return null;
  let dispatcher = dispatchers.get(engine);
  if (!dispatcher) {
    dispatcher = createSelectionDispatcher(engine);
    dispatchers.set(engine, dispatcher);
  }
  return dispatcher;
}

function safely(run) {
  try {
    return run();
  } catch {
    return false;
  }
}
