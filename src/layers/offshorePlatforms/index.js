import { msg, t } from '../../i18n/index.js';
import { OFFSHORE_LAYER_ID } from './records.js';
import { createOffshoreRenderer } from './rendering.js';

/** Per-instance static inventory lifetime. Disable releases all render/context state. */
export function createOffshorePlatformsLayer({
  source,
  services,
  rendererFactory = createOffshoreRenderer,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Offshore platforms require a snapshot source');
  let viewer;
  let enabled = false;
  let destroyed = false;
  let request = null;
  let pending = null;
  let snapshot = null;
  let renderer = null;
  let error = null;
  let lastUpdate = null;
  let notify = () => {};
  const layer = {
    id: OFFSHORE_LAYER_ID,
    name: 'Offshore Oil & Gas Platforms',
    icon: '▥',
    source: 'BSEE',
    updateInterval: 0,
    init(value) {
      if (viewer || destroyed)
        throw new Error('Offshore layer already initialized or destroyed');
      viewer = value;
    },
    enable(value, { signal } = {}) {
      if (destroyed || signal?.aborted) return Promise.resolve(false);
      viewer ||= value;
      enabled = true;
      if (pending) return pending;
      if (renderer) return Promise.resolve(true);
      const controller = new AbortController();
      request = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      pending = Promise.resolve().then(async () => {
        try {
          const loaded =
            snapshot ||
            (await source.getSnapshot({ signal: controller.signal }));
          if (controller.signal.aborted || destroyed) return false;
          snapshot = loaded;
          const display = await rendererFactory(viewer, loaded, services, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || destroyed) {
            display.destroy();
            return false;
          }
          renderer = display;
          error = null;
          lastUpdate = Date.now();
          notify();
          return true;
        } catch (cause) {
          if (!controller.signal.aborted && !destroyed) {
            error = msg('Offshore inventory could not be loaded');
            notify();
            console.warn('[Offshore platforms]', cause);
          }
          return false;
        } finally {
          signal?.removeEventListener('abort', abort);
          if (request === controller) {
            request = null;
            pending = null;
          }
        }
      });
      return pending;
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      pending = null;
      renderer?.destroy();
      renderer = null;
    },
    update() {
      return enabled && !renderer ? layer.enable() : enabled;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      layer.disable();
      snapshot = null;
      viewer = null;
    },
    setRowControlsListener(listener) {
      notify = typeof listener === 'function' ? listener : () => {};
    },
    getRowControls() {
      return {
        info: [
          t('U.S. Gulf federal waters'),
          snapshot
            ? t('Inventory snapshot {date}', {
                date: snapshot.metadata.releaseDate,
              })
            : t('Dated inventory; not live'),
          error
            ? t('Offshore inventory could not be loaded')
            : t('No removal date recorded; production status unknown'),
        ].join(' · '),
        legendCategorical: true,
        legend: [
          { color: '#ffb454', label: t('Surface structure') },
          { color: '#63d9ef', label: t('Subsea structure') },
          { color: '#b9c1cc', label: t('Structure type unknown') },
        ],
      };
    },
    getStats() {
      return {
        count: enabled ? snapshot?.records.length || 0 : 0,
        lastUpdate,
        error,
        snapshotDate: snapshot?.metadata.releaseDate || null,
        coverage: 'U.S. Gulf federal waters',
        static: true,
      };
    },
    getLodDiagnostics() {
      return (
        renderer?.getDiagnostics() || {
          active: 0,
          materialized: 0,
          total: 0,
          budgetLimit: 0,
        }
      );
    },
    getAnalystRecords(maxCount = 2000) {
      return enabled
        ? (snapshot?.records || []).slice(
            0,
            Math.max(0, Math.min(2000, maxCount)),
          )
        : [];
    },
  };
  return layer;
}
