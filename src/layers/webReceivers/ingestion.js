import { acceptCatalogRows } from './model.js';
import { CATALOG_FETCH_TIMEOUT_MS } from './policy.js';

export function createIngestion({ state: layerState, parts, source }) {
  async function fetchCatalog(signal) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      CATALOG_FETCH_TIMEOUT_MS,
    );
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await source.getCatalog({ signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function isCurrent(generation, sessionGeneration) {
    return (
      generation === layerState._requestGeneration &&
      sessionGeneration === layerState._sessionGeneration
    );
  }

  /** Refresh the directory; concurrent callers share one request. */
  function loadCatalog() {
    if (layerState._loadPromise) return layerState._loadPromise;
    const generation = ++layerState._requestGeneration;
    const sessionGeneration = layerState._sessionGeneration;
    layerState._abort?.abort();
    layerState._abort = new AbortController();
    layerState._loading = true;
    layerState._error = null;
    parts.presentation.emitState();
    layerState._loadPromise = (async () => {
      try {
        const body = await fetchCatalog(layerState._abort.signal);
        if (!isCurrent(generation, sessionGeneration)) return;
        const receivers = acceptCatalogRows(body);
        parts.rendering.reconcile(receivers);
        layerState._updatedAt =
          typeof body?.updatedAt === 'string'
            ? body.updatedAt
            : new Date().toISOString();
        layerState._stale = Boolean(body?.stale);
        layerState._degraded = Boolean(body?.degraded);
        layerState._sources =
          body?.sources && typeof body.sources === 'object'
            ? body.sources
            : null;
        layerState._error = receivers.length
          ? null
          : 'Directory returned no receivers';
      } catch (error) {
        if (!isCurrent(generation, sessionGeneration)) return;
        if (error?.name === 'AbortError') return;
        layerState._error =
          error?.message || 'Web receiver directory unavailable';
        layerState._degraded = layerState._receivers.length > 0;
      } finally {
        if (isCurrent(generation, sessionGeneration)) {
          layerState._loading = false;
          layerState._abort = null;
          parts.presentation.emitState();
        }
        layerState._loadPromise = null;
      }
    })();
    return layerState._loadPromise;
  }

  /** Resolve once the directory has loaded (used by the voice tools). */
  async function ensureLoaded() {
    if (layerState._receivers.length) return layerState._receivers;
    await loadCatalog();
    return layerState._receivers;
  }

  const methods = {
    /** Manager-owned refresh on the layer's interval. */
    async update() {
      if (!layerState._enabled) return;
      await loadCatalog();
    },
  };

  return { methods, loadCatalog, ensureLoaded };
}
