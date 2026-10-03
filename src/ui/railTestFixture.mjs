/** Minimal instrumented DOM for keyed rail presentation tests. */
export function railFixture(onWrite = () => {}) {
  const tracked = (target) =>
    new Proxy(target, {
      set(object, key, value) {
        onWrite(key);
        return Reflect.set(object, key, value);
      },
    });
  const document = {
    createElement(tag) {
      const node = new EventTarget();
      Object.assign(node, {
        tagName: tag.toUpperCase(),
        ownerDocument: document,
        children: [],
        dataset: tracked({}),
        style: tracked({}),
        hidden: false,
        textContent: '',
        attributes: new Map(),
        setAttribute(key, value) {
          onWrite('attribute');
          this.attributes.set(key, String(value));
        },
        getAttribute(key) {
          return this.attributes.get(key) ?? null;
        },
        appendChild(child) {
          return this.insertBefore(child, null);
        },
        insertBefore(child, reference) {
          if (child.parent) child.remove();
          onWrite('insert');
          const index = reference
            ? this.children.indexOf(reference)
            : this.children.length;
          this.children.splice(index, 0, child);
          child.parent = this;
          return child;
        },
        append(...nodes) {
          for (const child of nodes) this.appendChild(child);
        },
        remove() {
          if (!this.parent) return;
          onWrite('remove');
          this.parent.children.splice(this.parent.children.indexOf(this), 1);
          this.parent = null;
        },
        focus() {
          document.activeElement = this;
        },
        matches(selector) {
          if (selector.startsWith('.'))
            return this.className?.split(' ').includes(selector.slice(1));
          if (selector === '[data-chip-id]')
            return Boolean(this.dataset.chipId);
          return false;
        },
        closest(selector) {
          return this.matches(selector) ? this : this.parent?.closest(selector);
        },
        click() {
          if (this.disabled) return;
          const target = this;
          for (let node = this; node; node = node.parent) {
            const event = new Event('click');
            Object.defineProperty(event, 'target', { value: target });
            node.dispatchEvent(event);
          }
        },
        querySelector(selector) {
          return find(
            this,
            (child) =>
              selector.startsWith('.')
                ? child.className?.split(' ').includes(selector.slice(1))
                : false,
            false,
          );
        },
      });
      node.classList = {
        contains: (name) => node.className?.split(' ').includes(name) || false,
        toggle(name, enabled) {
          const classes = new Set(
            (node.className || '').split(' ').filter(Boolean),
          );
          if (enabled) classes.add(name);
          else classes.delete(name);
          const next = [...classes].join(' ');
          if (next !== node.className) {
            node.className = next;
            onWrite('className');
          }
        },
      };
      return tracked(node);
    },
  };
  const container = document.createElement('div');
  const find = (root, predicate, includeRoot = true) => {
    if (includeRoot && predicate(root)) return root;
    for (const child of root.children) {
      const result = find(child, predicate);
      if (result) return result;
    }
    return null;
  };
  return {
    container,
    document,
    find: (predicate, root = container) => find(root, predicate),
  };
}
