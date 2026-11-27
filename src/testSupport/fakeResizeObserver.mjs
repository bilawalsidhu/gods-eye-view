/**
 * Replace globalThis.ResizeObserver with one a test drives: `report(element,
 * width, height)` delivers a size to every observer watching the element.
 * `restore()` puts the previous constructor back.
 */
export function installFakeResizeObserver() {
  const previous = globalThis.ResizeObserver;
  const observers = [];
  globalThis.ResizeObserver = class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }
  };
  return {
    observers,
    /** Observers currently watching `element`. */
    watching: (element) =>
      observers.filter((observer) => observer.targets.has(element)),
    report(element, width, height) {
      for (const observer of observers)
        if (observer.targets.has(element))
          observer.callback(
            [{ target: element, contentRect: { width, height } }],
            observer,
          );
    },
    restore() {
      globalThis.ResizeObserver = previous;
    },
  };
}
