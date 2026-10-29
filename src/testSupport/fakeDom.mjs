/**
 * Just enough DOM for the rail and strip tests: a tree with classes,
 * attributes, inline style properties, boxes and events. There is no layout:
 * a test sets the offsets, rects and computed values it needs.
 */
export function makeDocument() {
  const doc = { activeElement: null };
  const descendants = (node) =>
    node.children.flatMap((child) => [child, ...descendants(child)]);
  const findIn = (node, predicate) => {
    for (const child of node.children) {
      if (predicate(child)) return child;
      const nested = findIn(child, predicate);
      if (nested) return nested;
    }
    return null;
  };
  doc.createElement = (tag) => {
    const el = new EventTarget();
    const attrs = new Map();
    const classes = new Set();
    const props = new Map();
    const writes = [];
    Object.assign(el, {
      tagName: tag.toUpperCase(),
      ownerDocument: doc,
      children: [],
      parentElement: null,
      dataset: {},
      scrollHeight: 0,
      clientHeight: 0,
      scrollTop: 0,
      rect: { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 },
      computed: { display: 'block', visibility: 'visible', opacity: '1' },
      // Every inline style write, in order, for write-if-changed assertions.
      writes,
      style: {
        props,
        setProperty(key, value) {
          writes.push(['set', key, value]);
          props.set(key, value);
        },
        removeProperty(key) {
          writes.push(['remove', key]);
          props.delete(key);
        },
        getPropertyValue: (key) => props.get(key) || '',
      },
      hidden: false,
      textContent: '',
      tabIndex: -1,
      title: '',
      type: '',
      id: '',
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle(name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
      },
      setAttribute: (key, value) => attrs.set(key, String(value)),
      getAttribute: (key) => attrs.get(key) ?? null,
      removeAttribute: (key) => attrs.delete(key),
      getBoundingClientRect: () => el.rect,
      contains(target) {
        return (
          target === el || el.children.some((child) => child.contains(target))
        );
      },
      insertBefore(child, reference) {
        child.remove();
        const index = reference ? el.children.indexOf(reference) : -1;
        el.children.splice(index < 0 ? el.children.length : index, 0, child);
        child.parentElement = el;
        return child;
      },
      append(...nodes) {
        for (const node of nodes) el.insertBefore(node, null);
      },
      prepend(...nodes) {
        for (const node of nodes.reverse())
          el.insertBefore(node, el.children[0] ?? null);
      },
      remove() {
        const parent = el.parentElement;
        if (!parent) return;
        parent.children.splice(parent.children.indexOf(el), 1);
        el.parentElement = null;
      },
      matches(selector) {
        if (selector === '[data-panel-id]') return 'panelId' in el.dataset;
        if (selector === '[data-rail-tab]') return 'railTab' in el.dataset;
        return false;
      },
      closest(selector) {
        return el.matches(selector)
          ? el
          : (el.parentElement?.closest(selector) ?? null);
      },
      /** Class selectors only, comma-separated. */
      querySelector(selector) {
        const wanted = selector.split(',').map((part) => part.trim().slice(1));
        return findIn(el, (node) =>
          wanted.some((name) => node.classList.contains(name)),
        );
      },
      /** A simple selector, or one scoped to the children with ':scope >'. */
      querySelectorAll(selector) {
        const own = selector.startsWith(':scope > ');
        const simple = own ? selector.slice(':scope > '.length) : selector;
        const pool = own ? el.children : descendants(el);
        return pool.filter((node) => node.matches(simple));
      },
      focus() {
        doc.activeElement = el;
      },
    });
    Object.defineProperties(el, {
      className: {
        get: () => [...classes].join(' '),
        set(value) {
          classes.clear();
          for (const name of String(value).split(/\s+/).filter(Boolean))
            classes.add(name);
        },
      },
      firstElementChild: { get: () => el.children[0] ?? null },
      nextElementSibling: {
        get: () => {
          const siblings = el.parentElement?.children;
          if (!siblings) return null;
          return siblings[siblings.indexOf(el) + 1] ?? null;
        },
      },
    });
    return el;
  };
  doc.createElementNS = (_namespace, tag) => doc.createElement(tag);
  doc.body = doc.createElement('body');
  doc.getElementById = (id) => findIn(doc.body, (node) => node.id === id);
  return doc;
}

/** Dispatch a bubbling event with `target` fixed to `el`. */
export function fire(el, type, props = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), props);
  Object.defineProperty(event, 'target', { value: el });
  for (let node = el; node; node = node.parentElement)
    node.dispatchEvent(event);
  return event;
}
