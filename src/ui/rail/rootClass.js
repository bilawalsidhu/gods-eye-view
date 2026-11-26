/**
 * Classes on the page's root element (`<html>`) that say what is on the page:
 * the Omnibar is shown, the voice control sits in the dock, a layer has a
 * World Timeline. A stylesheet selects on that state through them instead of
 * `body:has(...)`: Chrome checks a `:has()` on body again after every node
 * added or removed anywhere on the page, and restyles the whole page when it
 * does, while a class changes only when the state it names does.
 *
 * A rule selects such a class as `body:is(.has-omnibar *, #gev-omnibar)`.
 * The first argument holds when body is inside the class's element; the
 * second never matches body and gives the rule the specificity the
 * `:has(#gev-omnibar)` it replaced had, so the rule keeps its place in the
 * cascade.
 *
 * The classes live on `<html>` rather than `<body>`, whose class changes
 * several owners already follow to lay the page out again.
 *
 * Several holders can share a class; it stays on until the last lets go.
 */

/** @type {WeakMap<Document, Map<string, number>>} */
const holders = new WeakMap();

/**
 * Put `name` on `doc`'s root element until the returned release is called.
 * @param {Document | null | undefined} doc
 * @param {string} name
 * @returns {() => void} Lets go of the class; later calls do nothing.
 */
export function holdRootClass(doc, name) {
  const root = doc?.documentElement;
  if (!root) return () => {};
  let counts = holders.get(doc);
  if (!counts) holders.set(doc, (counts = new Map()));
  const count = counts.get(name) ?? 0;
  counts.set(name, count + 1);
  if (count === 0) root.classList.add(name);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (counts.get(name) ?? 1) - 1;
    if (left > 0) {
      counts.set(name, left);
      return;
    }
    counts.delete(name);
    doc.documentElement?.classList.remove(name);
  };
}

/**
 * Hold `name` on `doc`'s root element while `set(true)` was the last call.
 * @param {Document | null | undefined} doc
 * @param {string} name
 * @returns {{set: (on: boolean) => void, release: () => void}}
 */
export function rootClassSwitch(doc, name) {
  let release = null;
  const set = (on) => {
    if (on && !release) release = holdRootClass(doc, name);
    else if (!on && release) {
      release();
      release = null;
    }
  };
  return { set, release: () => set(false) };
}

/** Hold each class of `value` (`{name: on}`) that is on; let go of the rest. */
function apply(el, value) {
  const switches = (el._rootClasses ??= new Map());
  for (const [name, on] of Object.entries(value || {})) {
    let entry = switches.get(name);
    if (!entry)
      switches.set(name, (entry = rootClassSwitch(el.ownerDocument, name)));
    entry.set(Boolean(on));
  }
  for (const [name, entry] of switches)
    if (!value || !Object.hasOwn(value, name)) entry.set(false);
}

/**
 * `v-root-class="{ 'has-omnibar': true }"`: holds each named class on the
 * root element while the element is on the page and the class's value is
 * truthy. One per element. The hooks run inside Vue's patch, just before the
 * element is inserted, patched or removed, so the classes change with the
 * element itself: code that reads layout after the patch sees both.
 */
export const vRootClass = {
  beforeMount(el, { value }) {
    apply(el, value);
  },
  beforeUpdate(el, { value }) {
    apply(el, value);
  },
  beforeUnmount(el) {
    for (const entry of el._rootClasses?.values() ?? []) entry.release();
    el._rootClasses?.clear();
  },
};

/**
 * Hold `name` on `doc`'s root element while `test()` holds, testing again
 * after every change a MutationObserver reports. `observe(observer)` points
 * the observer at what to follow; it is called again after every change, so
 * it can follow nodes that come and go.
 * @param {Document} doc
 * @param {string} name
 * @param {() => boolean} test
 * @param {(observer: MutationObserver) => void} observe
 * @returns {() => void} Stops following and lets go of the class.
 */
export function followRootClass(doc, name, test, observe) {
  const entry = rootClassSwitch(doc, name);
  const Observer = doc?.defaultView?.MutationObserver;
  const observer =
    Observer &&
    new Observer(() => {
      observer.disconnect();
      observe(observer);
      entry.set(Boolean(test()));
    });
  if (observer) observe(observer);
  entry.set(Boolean(test()));
  return () => {
    observer?.disconnect();
    entry.release();
  };
}

/**
 * Hold `name` on `doc`'s root element while an element in body matches
 * `selector`, as `body:has(selector)` would: elements that match coming and
 * going anywhere in body, and the class attribute of each element matching
 * `watched` (the elements whose classes `selector` tests), are followed.
 * @param {Document} doc
 * @param {string} name
 * @param {string} selector
 * @param {string} watched
 * @returns {() => void} Stops following and lets go of the class.
 */
export function followSelectorRootClass(doc, name, selector, watched) {
  return followRootClass(
    doc,
    name,
    () => Boolean(doc.body?.querySelector(selector)),
    (observer) => {
      const body = doc.body;
      if (!body) return;
      observer.observe(body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['id'],
      });
      for (const el of body.querySelectorAll(watched))
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    },
  );
}
