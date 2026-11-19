/**
 * Receive the photo viewer to draw, out of several photo viewers mounting
 * in one host (see photoViewer.js): the one mounted last, by its mount key,
 * whatever order they present in. One view draws one viewer, so a viewer
 * still mounting when a later one presents is superseded: it settles its
 * mount as closed and stops presenting. Starts with the current one (null
 * while none is mounted).
 * @param {Iterable<{subscribeView?: Function}>} viewers
 * @param {(view: ?object) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribePhotoViewers(viewers, listener) {
  // Each viewer's current presentation.
  const shown = new Map();
  let ready = false;
  let last;
  const publish = () => {
    let next = null;
    for (const view of shown.values())
      if (!next || view.mountKey > next.mountKey) next = view;
    if (!ready || next === last) return;
    last = next;
    listener(next);
    // The others are not drawn: a mount still waiting on the view never
    // would be.
    if (next)
      for (const view of [...shown.values()])
        if (view.mountKey < next.mountKey) view.actions.supersede();
  };
  const unsubscribes = [];
  for (const viewer of viewers) {
    const unsubscribe = viewer?.subscribeView?.((view) => {
      if (view) shown.set(viewer, view);
      else shown.delete(viewer);
      publish();
    });
    if (typeof unsubscribe === 'function') unsubscribes.push(unsubscribe);
  }
  ready = true;
  publish();
  if (last === undefined) listener((last = null));
  return () => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  };
}
