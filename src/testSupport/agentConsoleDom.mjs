import { readFileSync } from 'node:fs';

/**
 * A minimal document holding the ids `agent-console.html` declares, so the
 * typed console can be mounted and driven under `node --test`.
 *
 * The id list is READ from the template rather than restated, so a renamed
 * element fails the test that mounts the console instead of silently handing
 * it a stub the real page would not have.
 */

/** Element ids the shipped console template declares. */
export function consoleTemplateIds() {
  const html = readFileSync(
    new URL('../ui/templates/agent-console.html', import.meta.url),
    'utf8',
  );
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
}

function createElement(tag) {
  const node = new EventTarget();
  Object.assign(node, {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: new Map(),
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    open: false,
    focused: false,
    scrollTop: 0,
    scrollHeight: 0,
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      this.scrollHeight = this.children.length * 10;
      return child;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const child of nodes) this.appendChild(child);
    },
    remove() {
      const siblings = this.parent?.children;
      if (!siblings) return;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parent = null;
    },
    isConnected: true,
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    blur() {
      this.focused = false;
    },
    getClientRects() {
      return [{ width: 10, height: 10 }];
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    matches(selector) {
      if (selector.startsWith('[') && selector.endsWith(']')) {
        const name = selector.slice(1, -1).replace(/^data-/, '');
        const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return this.dataset[key] !== undefined;
      }
      if (selector.startsWith('.')) {
        return this.classList.contains(selector.slice(1));
      }
      return this.tagName === selector.toUpperCase();
    },
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (node.matches?.(selector.split(',')[0].trim())) return node;
      }
      return null;
    },
    querySelector(selector) {
      const find = (node) => {
        for (const child of node.children) {
          if (child.matches?.(selector)) return child;
          const nested = find(child);
          if (nested) return nested;
        }
        return null;
      };
      return find(this);
    },
    querySelectorAll() {
      return [];
    },
    show() {
      this.open = true;
    },
    showModal() {
      this.open = true;
      this.modal = true;
    },
    close() {
      this.open = false;
    },
  });
  // Defined here, not through Object.assign, which would copy the getter's
  // value once instead of the getter itself.
  Object.defineProperties(node, {
    lastElementChild: { get: () => node.children.at(-1) ?? null },
    options: { get: () => node.children },
  });
  const classes = () => new Set(node.className.split(' ').filter(Boolean));
  node.classList = {
    contains: (name) => classes().has(name),
    add(...names) {
      const next = classes();
      for (const name of names) next.add(name);
      node.className = [...next].join(' ');
    },
    remove(...names) {
      const next = classes();
      for (const name of names) next.delete(name);
      node.className = [...next].join(' ');
    },
  };
  return node;
}

/**
 * Build the fake document plus named handles for the console's elements.
 *
 * @param {{ids?: string[]}} [options]
 */
export function agentConsoleDom({ ids = consoleTemplateIds() } = {}) {
  // A stand-in window: the box controller listens for pointer and resize
  // events here, not on the document.
  const view = Object.assign(new EventTarget(), {
    innerWidth: 1440,
    innerHeight: 900,
  });
  let pointerClock = 0;
  // An EventTarget, because the shared surface keyboard listens for Escape on
  // the document in the capture phase rather than on the surface.
  const document = Object.assign(new EventTarget(), {
    createElement,
    activeElement: null,
  });
  const elements = new Map(
    ids.map((id) => {
      const element = createElement('div');
      element.ownerDocument = document;
      return [id, element];
    }),
  );
  document.getElementById = (id) => elements.get(id) ?? null;
  // The console drags by its header, which the real template nests inside the
  // dialog. The fixture's elements are flat by id, so the one structural
  // relationship the console depends on is built explicitly.
  const header = createElement('header');
  header.ownerDocument = document;
  header.dataset.panelHeader = '';
  elements.get('agent-console')?.appendChild(header);
  const byId = (id) => {
    const element = elements.get(id);
    if (!element) throw new Error(`The console template has no #${id}`);
    return element;
  };
  return {
    document,
    elements,
    dialog: byId('agent-console'),
    header,
    chip: byId('agent-console-chip'),
    closeButton: byId('agent-console-close'),
    providerSelect: byId('agent-provider'),
    modelSelect: byId('agent-model'),
    transcript: byId('agent-transcript'),
    form: byId('agent-form'),
    input: byId('agent-input'),
    sendButton: byId('agent-send'),
    status: byId('agent-status'),
    cost: byId('agent-cost'),
    /** Click an element the way the browser would. */
    click(element) {
      element.dispatchEvent(new Event('click'));
    },
    /** Submit the console's form. */
    submit() {
      const event = new Event('submit');
      event.preventDefault = () => {};
      byId('agent-form').dispatchEvent(event);
    },
    /** Change a select and fire the event the console listens for. */
    select(element, value) {
      element.value = value;
      element.dispatchEvent(new Event('change'));
    },
    /** Press a pointer button on an element, as the window sees it. */
    pointer(element, type, { x = 0, y = 0, button = 0, pointerId = 1 } = {}) {
      const event = new Event(type);
      Object.assign(event, { clientX: x, clientY: y, button, pointerId });
      // `target` and `timeStamp` are getter-only on a real Event.
      for (const [name, value] of [
        ['target', element],
        ['currentTarget', element],
        ['timeStamp', pointerClock],
      ]) {
        Object.defineProperty(event, name, { configurable: true, value });
      }
      event.preventDefault = () => {};
      event.stopPropagation = () => {};
      // A press is delivered to the element; the rest of the gesture is
      // tracked on the window, as the controller listens for it there.
      if (type === 'pointerdown') element.dispatchEvent(event);
      else view.dispatchEvent(event);
      return event;
    },
    /** Advance the clock the double-press detector reads. */
    advance(ms) {
      pointerClock += ms;
    },
    view,

    /** Press a key, as the document-level surface keyboard sees it. */
    keydown(key) {
      const event = new Event('keydown');
      event.key = key;
      event.preventDefault = () => {};
      event.stopPropagation = () => {};
      document.dispatchEvent(event);
    },
    /** The transcript as [kind, text] pairs. */
    entries() {
      return byId('agent-transcript').children.map((child) => [
        child.className.replace('agent-entry agent-entry-', ''),
        child.textContent,
      ]);
    },
  };
}

/** A storage stand-in, optionally one that throws like a privacy mode does. */
export function fakeStorage({ throws = false } = {}) {
  const map = new Map();
  return {
    getItem(key) {
      if (throws) throw new Error('storage is unavailable');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throws) throw new Error('storage is unavailable');
      map.set(key, String(value));
    },
    removeItem(key) {
      if (throws) throw new Error('storage is unavailable');
      map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}
