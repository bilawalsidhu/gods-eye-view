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

export function fakeHost() {
  const doc = { createElement: (tag) => fakeElement(tag) };
  const host = fakeElement('div');
  host.ownerDocument = doc;
  return host;
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
