// One pointer owner per engine. A claim gates subscriptions without disabling
// camera gestures. Deferred picks from an older ownership epoch are discarded.
export function createExclusivePointer(suspend = () => () => {}) {
  let current = null;
  let epoch = 0;
  let destroyed = false;
  return {
    acquire() {
      if (destroyed || current) return null;
      const resume = suspend();
      const claim = {
        release() {
          if (current !== claim) return;
          current = null;
          epoch++;
          resume();
        },
      };
      current = claim;
      epoch++;
      return claim;
    },
    delivery() {
      const started = epoch;
      return (entry) =>
        started === epoch &&
        !destroyed &&
        (current ? entry.pointer === current : !entry.pointer);
    },
    destroy() {
      current?.release();
      destroyed = true;
    },
  };
}
