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
 *   presentation without one counts as the latest mount; among several
 *   without, the one that began presenting last is.
 * - `actions.supersede()`, where present, is called on each presentation
 *   not drawn once the pick changes. It runs on a microtask, after the
 *   presentation that won has reached every subscriber: a subscriber never
 *   sees the superseded one withdraw before it sees the one replacing it.
 * @param {Iterable<{subscribeView?: Function}>} viewers
 * @param {(view: ?object) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribePhotoViewers(viewers, listener) {
  // Each viewer's current presentation, and when it began presenting.
  const shown = new Map();
  let arrivals = 0;
  let ready = false;
  let closed = false;
  let superseding = false;
  let last;
  /** Whether `a` was mounted after `b`. */
  const later = (a, b) => {
    const key = ({ view }) =>
      Number.isFinite(view.mountKey) ? view.mountKey : Infinity;
    const ka = key(a);
    const kb = key(b);
    return ka !== kb ? ka > kb : a.arrival > b.arrival;
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
    if (!ready || next === last) return;
    last = next;
    listener(next);
    if (next && shown.size > 1 && !superseding) {
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
      else shown.set(viewer, { view, arrival: ++arrivals });
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
