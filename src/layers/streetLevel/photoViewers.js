/** The last key handed out by `nextViewKey()`. */
let viewKeys = 0;

/**
 * A key no viewer or picker was ever given: photo viewers key their mounts
 * and canvases with it, and a presentation without a mount key is stamped
 * with one when first seen, so both rank on one scale.
 */
export function nextViewKey() {
  return ++viewKeys;
}

/**
 * Each keyless viewer's current mount, `{actions, key}`: stamped once, by
 * whichever picker sees it first, and kept until it presents null, so a
 * picker made later ranks it the same.
 */
const keylessMounts = new WeakMap();

/**
 * Receive the photo viewer to draw, out of several photo viewers mounting
 * in one host (see photoViewer.js): the one mounted last, whatever order
 * they present in. One view draws one viewer, so a viewer still mounting
 * when a later one presents is superseded: it settles its mount as closed
 * and stops presenting. Starts with the current one (null while none is
 * mounted).
 *
 * Two fields of a presentation are read here (see ViewerAdapter.subscribeView
 * in registry.js):
 * - `mountKey`, a number larger for each later mount (from `nextViewKey()`),
 *   orders the mounts. A presentation without one counts as mounted when
 *   any picker first saw it present: it is stamped with a `nextViewKey()`
 *   then, the same for every picker, however many are made later.
 * - `actions.supersede()`, where present, is called on each presentation
 *   not drawn, whenever more than one presents. It runs on a microtask,
 *   after the presentation that won has reached every subscriber: a
 *   subscriber never sees the superseded one withdraw before it sees the
 *   one replacing it.
 * @param {Iterable<{subscribeView?: Function}>} viewers
 * @param {(view: ?object) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribePhotoViewers(viewers, listener) {
  // Each viewer's current presentation and its rank, {view, key}.
  const shown = new Map();
  let ready = false;
  let closed = false;
  let superseding = false;
  let last;
  /** A mount's rank: its key, or the stamp of its first presentation. */
  const rank = (viewer, view) => {
    if (Number.isFinite(view.mountKey)) return view.mountKey;
    let mount = keylessMounts.get(viewer);
    if (!mount || mount.actions !== view.actions) {
      mount = { actions: view.actions, key: nextViewKey() };
      keylessMounts.set(viewer, mount);
    }
    return mount.key;
  };
  // The others are not drawn: a mount still waiting on the view never
  // would be.
  const supersede = () => {
    superseding = false;
    if (closed || !last) return;
    for (const { view } of [...shown.values()])
      if (view !== last) view.actions?.supersede?.();
  };
  const publish = () => {
    let next = null;
    for (const entry of shown.values())
      if (!next || entry.key > next.key) next = entry;
    next = next?.view ?? null;
    if (!ready) return;
    if (next !== last) {
      last = next;
      listener(next);
    }
    if (last && shown.size > 1 && !superseding) {
      superseding = true;
      queueMicrotask(supersede);
    }
  };
  const unsubscribes = [];
  for (const viewer of viewers) {
    const unsubscribe = viewer?.subscribeView?.((view) => {
      if (closed) return;
      if (!view) {
        shown.delete(viewer);
        keylessMounts.delete(viewer);
      } else shown.set(viewer, { view, key: rank(viewer, view) });
      publish();
    });
    if (typeof unsubscribe === 'function') unsubscribes.push(unsubscribe);
  }
  ready = true;
  publish();
  if (last === undefined) listener((last = null));
  return () => {
    closed = true;
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  };
}
