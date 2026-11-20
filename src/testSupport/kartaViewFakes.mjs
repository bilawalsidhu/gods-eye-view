// DOM stand-ins for the KartaView viewer's tests (no browser in Node).
import { subscribePhotoViewers } from '../layers/streetLevel/photoViewers.js';

/** A DOM element with what the viewer touches: children, events, attributes. */
function fakeElement(tag) {
  const listeners = new Map();
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attributes: {},
    hidden: false,
    disabled: false,
    clientWidth: 400,
    clientHeight: 250,
    classList: {
      values: new Set(),
      add: (name) => element.classList.values.add(name),
      remove: (name) => element.classList.values.delete(name),
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = element;
        element.children.push(node);
      }
    },
    remove() {
      const list = element.parentNode?.children;
      if (list) list.splice(list.indexOf(element), 1);
      element.parentNode = null;
    },
    replaceWith(next) {
      const parent = element.parentNode;
      if (!parent) return;
      parent.children[parent.children.indexOf(element)] = next;
      next.parentNode = parent;
      next.ownerDocument = element.ownerDocument;
      element.parentNode = null;
    },
    setAttribute: (name, value) => (element.attributes[name] = value),
    removeAttribute: (name) => {
      delete element.attributes[name];
      if (name === 'src') element.src = '';
    },
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    setPointerCapture() {},
    /** Fire an event at the element's listener. */
    fire(type, event = {}) {
      return listeners.get(type)?.({
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        ...event,
      });
    },
  };
  return element;
}

/**
 * A host element; given a photo viewer, its view is drawn as
 * StreetLevelPhotoViewer draws it (see `drawPhotoViewer`).
 */
export function fakeHost(viewer = null) {
  const host = fakeElement('div');
  if (viewer) drawPhotoViewer(viewer);
  return host;
}

/**
 * The one view of the photo viewers given to `drawPhotoViewer`, as the
 * application has one StreetLevelPhotoViewer: the viewers reach it through
 * photoViewers.js's picker, as the layer's `subscribePhotoViewer()` does,
 * so only the mount made last is drawn and the earlier ones are superseded.
 */
const shared = {
  viewers: new Set(),
  draw: null,
  unsubscribe: null,
  generation: 0,
};

/** Subscribe the view to the viewers it has now, then let the old picker go. */
function resubscribe() {
  const previous = shared.unsubscribe;
  const generation = ++shared.generation;
  // The new picker first: a viewer is never left without a view.
  shared.unsubscribe = subscribePhotoViewers([...shared.viewers], (view) => {
    if (generation === shared.generation) shared.draw(view);
  });
  previous?.();
}

/**
 * Start the shared view afresh, with no viewer: a test file calls it before
 * each test, so a viewer left by an earlier test is not drawn with a later
 * test's (nor superseded by it). A viewer it held is left without a view.
 */
export function resetPhotoView() {
  shared.generation++;
  shared.unsubscribe?.();
  shared.unsubscribe = null;
  shared.viewers.clear();
  shared.draw = null;
}

/**
 * Draw a photo viewer with the shared view, alongside every other viewer
 * given here since the last `resetPhotoView()` (see `shared`).
 * @returns {() => void} Stop drawing it.
 */
export function drawPhotoViewer(viewer) {
  shared.draw ??= photoView();
  shared.viewers.add(viewer);
  resubscribe();
  return () => {
    if (shared.viewers.delete(viewer)) resubscribe();
  };
}

/**
 * A view drawing the presentations it is given with fake elements, as
 * StreetLevelPhotoViewer does through Vue: changes made in one tick are
 * drawn once, on a microtask, with their final value; the root (keyed by
 * the mount) holds the picture, the panorama canvas (keyed by its canvas
 * key) and the ‹ › buttons, kept while their keys are, and every element
 * is handed back on each draw. A value is written only when the drawn
 * presentation changes it, and the elements' events reach the viewer's
 * actions.
 * @returns {(view: ?object) => void} Draw this presentation.
 */
function photoView() {
  let parts = null;
  let last = null;
  let pending = null;
  let queued = false;
  const on = (element, type, name) =>
    element.addEventListener(type, (event) => last?.actions[name](event));
  const canvasFor = () => {
    const canvas = fakeElement('canvas');
    canvas.classList.add('sl-photo-pano');
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel'])
      on(canvas, type, type);
    on(canvas, 'pointercancel', 'pointerup');
    on(canvas, 'webglcontextlost', 'contextLost');
    return canvas;
  };
  const build = (view) => {
    const root = fakeElement('div');
    const picture = fakeElement('img');
    const canvas = canvasFor();
    const button = (delta) => {
      const element = fakeElement('button');
      element.addEventListener('click', (event) =>
        last?.actions.step(delta, event),
      );
      return element;
    };
    const prev = button(-1);
    const next = button(1);
    on(root, 'keydown', 'keydown');
    root.append(picture, canvas, prev, next);
    view.host.append(root);
    return { root, picture, canvas, prev, next };
  };
  const draw = (view) => {
    if (!view) {
      parts?.root.remove();
      parts = last = null;
      return;
    }
    if (!parts || last.mountKey !== view.mountKey) {
      parts?.root.remove();
      parts = build(view);
      last = null;
    } else if (last.host !== view.host) {
      parts.root.remove();
      view.host.append(parts.root);
    }
    const changed = (key) => !last || last[key] !== view[key];
    let canvasFresh = !last;
    if (last && changed('canvasKey')) {
      const canvas = canvasFor();
      parts.canvas.replaceWith(canvas);
      parts.canvas = canvas;
      canvasFresh = true;
    }
    const { root, picture, canvas, prev, next } = parts;
    if (changed('providerId')) root.dataset.provider = view.providerId;
    if (changed('label')) root.attributes['aria-label'] = view.label;
    if (changed('kind') && view.kind !== undefined)
      root.dataset.kind = view.kind;
    if (changed('alt')) picture.alt = view.alt;
    if (changed('src')) {
      if (view.src) picture.src = view.src;
      else picture.removeAttribute('src');
    }
    if (changed('fit')) picture.style.objectFit = view.fit;
    if (changed('kind')) picture.hidden = view.kind !== 'flat';
    if (changed('kind') || canvasFresh) canvas.hidden = view.kind !== 'pano';
    if (changed('dragging') || canvasFresh) {
      if (view.dragging) canvas.classList.add('sl-photo-dragging');
      else canvas.classList.remove('sl-photo-dragging');
    }
    if (changed('prevLabel')) prev.attributes['aria-label'] = view.prevLabel;
    if (changed('nextLabel')) next.attributes['aria-label'] = view.nextLabel;
    if (changed('prevDisabled')) prev.disabled = view.prevDisabled;
    if (changed('nextDisabled')) next.disabled = view.nextDisabled;
    last = view;
    for (const name of ['root', 'picture', 'canvas', 'prev', 'next'])
      view.actions.attach(name, parts[name]);
  };
  return (view) => {
    pending = view;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      draw(pending);
    });
  };
}

/**
 * Wait, a macrotask at a time, until `condition` holds; false if it never
 * does within `ticks`. A test asserting that something did not happen waits
 * on a sign that the work is done instead of a fixed count of ticks.
 */
export async function until(condition, { ticks = 200 } = {}) {
  for (let i = 0; i < ticks; i++) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return Boolean(await condition());
}

/** Let a photo viewer's view draw what was presented in this tick. */
export const drawn = () => new Promise((resolve) => queueMicrotask(resolve));
