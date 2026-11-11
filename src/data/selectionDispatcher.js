import { sceneServicesFor } from './sceneServices.js';
// Shared selection for registered owners, with one pick subscription and
// press accumulator. Normal owners select their first pick, clear on a short
// empty click, and retain selection on another owner's pick. Pass-through
// picks yield to the next hit; drill-through owners may select below an
// unregistered owner's hit. Pointer claims suppress selection.
// Look-under owners select below unowned picks or their declared pass-through
// ids, clear on other owners, and ignore clicks containing only those ids.
// Own-rule owners receive every pointer-free click and apply their own rules.

import { isPointerFree as pointerFree } from './inputOwnership.js';
import { pickRegistryFor, resolvePickId } from './pickRegistry.js';
import {
  createPressGesture,
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingGesture.js';

const SELECTION_DRILL = 8;

/**
 * @param {import('../globe/contract.js').GlobeEngine} engine
 * @param {{ keyTarget?: EventTarget, now?: () => number, isPointerFree?: () => boolean }} [options]
 */
export function createSelectionDispatcher(
  engine,
  {
    picking = pickRegistryFor(engine),
    keyTarget = globalThis.document,
    now = () => performance.now(),
    isPointerFree = pointerFree,
  } = {},
) {
  const {
    findPickOwner,
    registerPickOwner,
    unregisterPickOwner,
    nearbyContact,
  } = picking;
  const owners = new Map();
  let removers = [];
  let destroyed = false;

  const press = createPressGesture(now);

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
    const gesture = press.click(event.position);
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
      engine.input.on('down', (event) => press.down(event.position)),
      engine.input.on('move', (event) => press.move(event.endPosition)),
      engine.input.on('up', (event) => press.up(event.position)),
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

/** The selection dispatcher owned by the engine's attached scene. */
export function selectionDispatcherFor(engine) {
  return sceneServicesFor(engine)?.selection ?? null;
}

function safely(run) {
  try {
    return run();
  } catch {
    return false;
  }
}
