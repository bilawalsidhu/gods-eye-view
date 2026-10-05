/** Own one user-triggered action at a time; cancellation settles even an uncooperative adapter. */
export function createInteractionSession({ execute, changed = () => {} }) {
  let controller,
    active = false,
    busy = false,
    selected = null;
  let actions = new Map();
  const state = () => ({ active, busy, selected, count: actions.size });
  function clear() {
    active = false;
    busy = false;
    selected = null;
    actions.clear();
    controller?.abort();
    controller = null;
    changed(state());
  }
  return {
    clear,
    getState: state,
    activate(items) {
      clear();
      actions = new Map(items.map((item) => [item.id, item]));
      active = !!actions.size;
      changed(state());
    },
    async dispatch(id) {
      const item = actions.get(id);
      if (!active || busy || !item) return false;
      const current = new AbortController();
      controller = current;
      busy = true;
      selected = id;
      changed(state());
      let abort;
      try {
        const cancelled = new Promise((resolve) => {
          abort = () => resolve(false);
          current.signal.addEventListener('abort', abort, { once: true });
        });
        const work = Promise.resolve().then(() => {
          if (current.signal.aborted) return false;
          return execute(item, current.signal);
        });
        return (
          (await Promise.race([work, cancelled])) !== false &&
          !current.signal.aborted
        );
      } catch {
        return false;
      } finally {
        current.signal.removeEventListener('abort', abort);
        if (controller === current) {
          busy = false;
          controller = null;
          changed(state());
        }
      }
    },
  };
}
