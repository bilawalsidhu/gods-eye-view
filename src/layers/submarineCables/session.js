import { msg } from '../../i18n/index.js';
import { waitForSignal } from '../../sources/requestDeadline.js';

/**
 * The dataset is acquired once per activation, independently of scene
 * attachment; `createDisplay(engine)` draws it on each attached engine
 * (show(dataset), hide(), destroy(), stats()).
 */
export function createCableSessionLayer({ source, createDisplay }) {
  const id = 'telegeography-submarine-cables';
  let data,
    request,
    controller,
    display,
    enabled = false,
    disposed = false,
    updated = null,
    error = null;
  function read() {
    if (data) return Promise.resolve(data);
    if (!request) {
      const token = new AbortController();
      controller = token;
      request = source
        .fetch(token.signal)
        .then((result) => {
          token.signal.throwIfAborted();
          if (
            !Array.isArray(result?.cables?.features) ||
            !Array.isArray(result?.landingPoints?.features)
          )
            throw Error('Invalid submarine cable dataset');
          updated = Date.now();
          return (data = result);
        })
        .finally(() => {
          if (controller === token) {
            controller = request = null;
          }
        });
    }
    return request;
  }
  let rendering = null;
  function show() {
    if (rendering) return rendering;
    const owner = display;
    if (!owner) return;
    const result = (async () => {
      try {
        const next = await read();
        if (enabled && display === owner && !disposed) {
          error = null;
          await owner.show(next);
        }
      } catch (e) {
        if (
          !disposed &&
          enabled &&
          owner === display &&
          e?.name !== 'AbortError'
        )
          error = e?.message || msg('TeleGeography load failed');
      }
    })();
    rendering = result;
    return result.finally(() => {
      if (rendering === result) rendering = null;
    });
  }
  return {
    id,
    name: 'Submarine Cables',
    icon: '≋',
    source: source.label,
    updateInterval: 0,
    statsRefreshInterval: 500,
    init(_viewer, ctx) {
      return this.attachRenderer(ctx);
    },
    attachRenderer({ engine = null, signal = null } = {}) {
      display = engine ? createDisplay(engine) : null;
      // The cable data load belongs to the session and keeps running; only
      // this scene's wait for it ends when the scene is released. show()
      // draws nothing into a display that was released meanwhile.
      if (enabled)
        return waitForSignal(show(), signal).catch((error) => {
          if (!signal?.aborted) throw error;
        });
    },
    detachRenderer() {
      const owner = display;
      display = rendering = null;
      owner?.destroy();
    },
    enable() {
      enabled = true;
      return show();
    },
    update() {
      if (enabled) return show();
    },
    disable() {
      enabled = false;
      controller?.abort();
      controller = request = rendering = null;
      error = null;
      display?.hide();
    },
    destroy() {
      this.disable();
      this.detachRenderer();
      disposed = true;
      data = null;
    },
    getStats() {
      const s = display?.stats?.() ?? {};
      return {
        ...s,
        count:
          enabled && data
            ? data.cables.features.length + data.landingPoints.features.length
            : 0,
        loading: Boolean(request) || Boolean(s.loading),
        lastUpdate: updated,
        error: error ?? s.error ?? null,
      };
    },
  };
}
