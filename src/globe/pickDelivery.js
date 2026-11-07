// Delivers input events to listeners that asked for picks (input.on with
// { pick, drill }), for every engine: one pick per window (and one drill, as deep as
// the deepest listener asked) per event, shared by its listeners; moves are
// coalesced to one delivery per frame with the latest position. Picks may
// be asynchronous (Navara answers clicks from its GPU pick of the gesture):
// listeners still registered when the answer arrives get it.

const settle = (value, then) =>
  value && typeof value.then === 'function' ? value.then(then) : then(value);

/**
 * @param {{ pick: (position: object, type: string) => any, drill: (position: object, limit: number) => any,
 *   schedule: (run: () => void) => void }} ports `schedule` runs a callback
 *   once on the next frame (requestAnimationFrame in a browser).
 */
export function createPickDelivery({ pick, drill, schedule }) {
  let pendingMove = null;

  function runWindow(type, event, entries, isLive) {
    const at = event.position ?? event.endPosition;
    const depth = entries.reduce(
      (most, entry) => Math.max(most, entry.drill),
      0,
    );
    return settle(pick(at, type, entries[0].pickWindow), (picked) =>
      settle(
        depth ? drill(at, depth, entries[0].pickWindow) : undefined,
        (drilled) => {
          for (const entry of entries) {
            if (!isLive(entry)) continue;
            entry.listener({
              ...event,
              picked,
              ...(entry.drill
                ? { drilled: (drilled ?? []).slice(0, entry.drill) }
                : {}),
            });
          }
        },
      ),
    );
  }

  function run(type, event, entries, isLive) {
    const windows = new Map();
    for (const entry of entries) {
      if (!isLive(entry)) continue;
      const key = entry.pickWindow
        ? `${entry.pickWindow.width}:${entry.pickWindow.height}`
        : 'default';
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push(entry);
    }
    return Promise.all(
      [...windows.values()].map((group) =>
        runWindow(type, event, group, isLive),
      ),
    );
  }

  return {
    /**
     * @param {string} type
     * @param {object} event the contract event, without picks
     * @param {{ listener: Function, pick: boolean, drill: number }[]} entries
     * @param {{ isLive?: (entry: object) => boolean }} [options]
     * @returns {void | Promise<void>} settled once the pick listeners ran
     */
    deliver(type, event, entries, { isLive = () => true } = {}) {
      const pickers = [];
      for (const entry of entries)
        if (entry.pick) pickers.push(entry);
        else if (isLive(entry)) entry.listener(event);
      if (!pickers.length) return undefined;
      if (type !== 'move') return run(type, event, pickers, isLive);
      const scheduled = pendingMove !== null;
      pendingMove = { event, pickers, isLive };
      if (!scheduled)
        schedule(() => {
          const latest = pendingMove;
          pendingMove = null;
          run('move', latest.event, latest.pickers, latest.isLive);
        });
      return undefined;
    },
  };
}
