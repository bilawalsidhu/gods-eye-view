/** Own deferred UI presentation and listeners until synchronous teardown. */
export class UiLifetime {
  constructor() {
    this.destroyed = false;
    this.removers = new Set();
    this.frames = new Set();
    this.timers = new Set();
  }
  listen(target, type, callback, options) {
    if (this.destroyed || !target) return () => {};
    const remove = () => {
      target.removeEventListener(type, listener, options);
      this.removers.delete(remove);
    };
    const listener = (event) => {
      if (options?.once) remove();
      if (!this.destroyed) return callback(event);
    };
    target.addEventListener(type, listener, options);
    this.removers.add(remove);
    return remove;
  }
  frame(callback) {
    if (this.destroyed) return null;
    const frame = requestAnimationFrame((time) => {
      this.frames.delete(frame);
      if (!this.destroyed) callback(time);
    });
    this.frames.add(frame);
    return frame;
  }
  timeout(callback, delay) {
    if (this.destroyed) return null;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }
  cancelTimeout(timer) {
    clearTimeout(timer);
    this.timers.delete(timer);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const remove of this.removers) remove();
    for (const frame of this.frames) cancelAnimationFrame(frame);
    for (const timer of this.timers) clearTimeout(timer);
    this.frames.clear();
    this.timers.clear();
  }
}
