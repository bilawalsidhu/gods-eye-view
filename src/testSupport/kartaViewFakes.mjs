// DOM stand-ins for the KartaView viewer's tests (no browser in Node).

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
 * Draw a photo viewer's presentations with fake elements, as
 * StreetLevelPhotoViewer does: the root in the host it names, holding the
 * picture, the panorama canvas and the ‹ › buttons, each handed back; a
 * value is written only when the presentation changes it (as Vue patches),
 * and the elements' events reach the viewer's actions. A new canvas key
 * puts a fresh canvas in the old one's place.
 * @returns {() => void} Stop drawing.
 */
export function drawPhotoViewer(viewer) {
  let parts = null;
  let last = null;
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
  const changed = (view, key) => !last || last[key] !== view[key];
  return viewer.subscribeView((view) => {
    if (!view) {
      parts?.root.remove();
      parts = last = null;
      return;
    }
    const fresh = !parts || last.host !== view.host;
    if (fresh) {
      parts?.root.remove();
      parts = build(view);
      last = null;
    }
    const { root, picture, prev, next } = parts;
    if (!fresh && changed(view, 'canvasKey')) {
      const canvas = canvasFor();
      parts.canvas.replaceWith(canvas);
      parts.canvas = canvas;
      parts.canvasFresh = true;
    }
    const { canvas } = parts;
    if (changed(view, 'providerId')) root.dataset.provider = view.providerId;
    if (changed(view, 'label')) root.attributes['aria-label'] = view.label;
    if (changed(view, 'kind') && view.kind !== undefined)
      root.dataset.kind = view.kind;
    if (changed(view, 'alt')) picture.alt = view.alt;
    if (changed(view, 'src')) {
      if (view.src) picture.src = view.src;
      else picture.removeAttribute('src');
    }
    if (changed(view, 'fit')) picture.style.objectFit = view.fit;
    if (changed(view, 'kind') || parts.canvasFresh) {
      picture.hidden = view.kind !== 'flat';
      canvas.hidden = view.kind !== 'pano';
    }
    if (changed(view, 'dragging') || parts.canvasFresh) {
      if (view.dragging) canvas.classList.add('sl-photo-dragging');
      else canvas.classList.remove('sl-photo-dragging');
    }
    if (changed(view, 'prevLabel'))
      prev.attributes['aria-label'] = view.prevLabel;
    if (changed(view, 'nextLabel'))
      next.attributes['aria-label'] = view.nextLabel;
    if (changed(view, 'prevDisabled')) prev.disabled = view.prevDisabled;
    if (changed(view, 'nextDisabled')) next.disabled = view.nextDisabled;
    const handBack = fresh || parts.canvasFresh;
    parts.canvasFresh = false;
    last = view;
    if (fresh)
      for (const name of ['root', 'picture', 'canvas', 'prev', 'next'])
        view.actions.attach(name, parts[name]);
    else if (handBack) view.actions.attach('canvas', canvas);
  });
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
