// Minimal DOM fixture for actual control/card/binder composition, not layout proof.
class Element {
  constructor(doc, tag = 'div') {
    Object.assign(this, {
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      children: [],
      attributes: new Map(),
      dataset: {},
      hidden: false,
      value: '',
      checked: false,
      listeners: new Map(),
      style: { setProperty() {}, removeProperty() {} },
    });
    this.classList = {
      add: (...names) => names.forEach((n) => this.classes.add(n)),
      remove: (...names) => names.forEach((n) => this.classes.delete(n)),
      contains: (name) => this.classes.has(name),
    };
    this.classes = new Set();
  }
  set id(value) {
    this.attributes.set('id', value);
  }
  get id() {
    return this.attributes.get('id') || '';
  }
  set className(value) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classes].join(' ');
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
    if (name === 'hidden') this.hidden = true;
    if (name === 'value') this.value = value;
    if (name.startsWith('data-'))
      this.dataset[
        name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      ] = value;
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  get isConnected() {
    return (
      this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected)
    );
  }
  get parentElement() {
    return this.parentNode;
  }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    const voids = new Set(['INPUT', 'IMG', 'BR', 'HR']);
    for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
      if (match[1]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const node = new Element(this.ownerDocument, match[2]);
      for (const attr of match[3].matchAll(/([^\s=\/]+)(?:="([^"]*)")?/g))
        node.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1).appendChild(node);
      if (!voids.has(node.tagName)) stack.push(node);
    }
  }
  set textContent(value) {
    this.text = String(value);
  }
  get textContent() {
    return this.text ?? '';
  }
  appendChild(node) {
    node.remove();
    this.children.push(node);
    node.parentNode = this;
    return node;
  }
  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }
  insertBefore(node, before) {
    node.remove();
    const at = this.children.indexOf(before);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parentNode = this;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode)
      this.parentNode.children = this.parentNode.children.filter(
        (n) => n !== this,
      );
    this.parentNode = null;
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    return this.children.flatMap((n) => [
      ...(n.matches(selector) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  checkVisibility() {
    return (
      this.isConnected &&
      !this.hidden &&
      (!this.parentNode || this.parentNode.checkVisibility())
    );
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    if (options.signal)
      options.signal.addEventListener(
        'abort',
        () => this.removeEventListener(type, listener),
        { once: true },
      );
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type, fields = {}) {
    const event = {
      type,
      target: this,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    for (const listener of [...(this.listeners.get(type) || [])])
      listener.call(this, event);
    return event;
  }
}

const installed = new WeakMap();
export function installPanelDom(t) {
  if (installed.has(t)) return installed.get(t);
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
  };
  const doc = new EventTarget();
  doc.body = new Element(doc, 'body');
  doc.documentElement = new Element(doc, 'html');
  doc.documentElement.lang = 'en';
  doc.activeElement = doc.body;
  doc.createElement = (tag) => new Element(doc, tag);
  doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  const win = new EventTarget();
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.Element = Element;
  installed.set(t, doc);
  t.after(() => Object.assign(globalThis, previous));
  return doc;
}

export function controlledClock() {
  let now = 0,
    next = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++next;
      tasks.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => tasks.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, task] of [...tasks])
        if (task.at <= now && tasks.delete(id)) task.fn();
    },
  };
}
