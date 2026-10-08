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
  node.classList = {
    contains: (name) =>
      node.className.split(' ').filter(Boolean).includes(name),
  };
  return node;
}

/**
 * Build the fake document plus named handles for the console's elements.
 *
 * @param {{ids?: string[]}} [options]
 */
export function agentConsoleDom({ ids = consoleTemplateIds() } = {}) {
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
  const byId = (id) => {
    const element = elements.get(id);
    if (!element) throw new Error(`The console template has no #${id}`);
    return element;
  };
  return {
    document,
    elements,
    dialog: byId('agent-console'),
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
    get size() {
      return map.size;
    },
  };
}
