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
 * - `mountKey`, a number larger for each later mount, orders the mounts. A
 *   presentation without one counts as mounted when it began presenting:
 *   after every mount presenting before it, before any later mount, keyed
 *   or not.
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
  // Each viewer's current presentation and its rank, {key, arrival}.
  const shown = new Map();
  let arrivals = 0;
  /** The largest mount key seen: a keyless mount ranks just after it. */
  let latestKey = -Infinity;
  let ready = false;
  let closed = false;
  let superseding = false;
  let last;
  /** Whether `a` was mounted after `b`. */
  const later = (a, b) =>
    a.key !== b.key ? a.key > b.key : a.arrival > b.arrival;
  /** A new mount's rank: its key, or, without one, the latest key seen. */
  const rank = (view) => {
    const keyed = Number.isFinite(view.mountKey);
    if (keyed) latestKey = Math.max(latestKey, view.mountKey);
    return {
      key: keyed ? view.mountKey : latestKey,
      // A keyed mount comes before a keyless one ranked on its key.
      arrival: keyed ? 0 : ++arrivals,
    };
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
      if (!next || later(entry, next)) next = entry;
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
      const entry = shown.get(viewer);
      if (!view) shown.delete(viewer);
      else if (entry && entry.view.mountKey === view.mountKey)
        entry.view = view;
      else shown.set(viewer, { view, ...rank(view) });
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
