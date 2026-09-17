import * as Cesium from 'cesium';
import {
  LAYER_ID,
  LAYER_NAME,
  REFRESH_MS,
  PAGE_DWELL_MS,
  BOARD_TEXT,
} from './policy.js';
import { createSignPresentation } from './presentation.js';
export { createMessageSignsSource } from './source.js';

/**
 * Electronic message signs.
 *
 * A source fetches the active sign list with an AbortSignal and resolves
 * `{ records }`. Records carry a stable string id, lat/lon in degrees, an
 * optional `headingDeg` (the direction of TRAVEL the sign addresses, not where
 * its face points — see faceBearingDeg), and one or more `pages`, each with
 * `textLines` or an `imageUrl`.
 *
 * The whole list is small, so this fetches all of it on a timer rather than
 * following the camera as the viewport-bounded layers do.
 *
 * @param {object} options
 * @param {object} options.source
 * @param {object} options.services
 * @returns {object} A DataLayerManager-compatible layer.
 */
export function createMessageSignsLayer({ source, services } = {}) {
  if (typeof source?.fetch !== 'function')
    throw new TypeError('Message signs require a sign source');

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    loading: false,
    records: [],
    recordById: new Map(),
    selectedId: null,
    error: null,
    status: 'idle',
    lastUpdate: null,
    abort: null,
    pageTimer: null,
    clickHandler: null,
  };

  const presentation = createSignPresentation({ state, services, source });
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  async function loadSigns() {
    if (!state.enabled || state.loading) return;
    state.loading = true;
    state.status = 'loading';
    state.abort?.abort();
    const controller = new AbortController();
    state.abort = controller;
    try {
      const { records } = await source.fetch(controller.signal);
      if (!state.enabled || controller.signal.aborted) return;
      state.records = records;
      state.recordById = new Map(records.map((r) => [r.id, r]));
      state.error = null;
      state.status = 'ready';
      state.lastUpdate = Date.now();
      presentation.render();
      // The face needs a warm ground floor to be placed: paint markers first,
      // resolve the cells, then repaint with the boards on the terrain.
      await services.groundFloor.resolveGroundFloorCellsBounded(records);
      if (state.enabled) presentation.render();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      // Keep what is on screen; the next refresh is a minute away.
      state.error = error?.message || String(error);
      state.status = 'error';
    } finally {
      state.loading = false;
    }
  }

  /**
   * Repaint so multi-page boards cycle. Runs only while some sign has more
   * than one page, so the single-page case costs no timer.
   */
  function schedulePageCycle() {
    clearInterval(state.pageTimer);
    state.pageTimer = null;
    if (!state.records.some((record) => record.pages.length > 1)) return;
    state.pageTimer = setInterval(() => {
      if (state.enabled) presentation.render();
    }, PAGE_DWELL_MS);
  }

  return {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: '🪧',
    source: source.label || LAYER_NAME,
    updateInterval: REFRESH_MS,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (state.viewer)
        throw new Error('Message sign layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource('message-signs');
      viewer.dataSources.add(state.dataSource);
      presentation.installInteraction(viewer);
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
      if (state.dataSource) state.dataSource.show = true;
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },

    disable() {
      state.enabled = false;
      unregisterPickOwner(LAYER_ID);
      clearInterval(state.pageTimer);
      state.pageTimer = null;
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      if (state.dataSource) state.dataSource.show = false;
      presentation.clearSelection();
      presentation.clearRendered();
      state.status = 'idle';
    },

    async update() {
      await loadSigns();
      schedulePageCycle();
    },

    destroy(viewer = state.viewer) {
      this.disable();
      state.clickHandler?.destroy();
      state.clickHandler = null;
      presentation.clearRendered();
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.records = [];
      state.recordById = new Map();
      state.selectedId = null;
      state.lastUpdate = null;
      state.error = null;
      state.viewer = null;
    },

    getStats() {
      return {
        count: state.records.length,
        status: state.status,
        error: state.error,
        lastUpdate: state.lastUpdate,
      };
    },

    getRowControls() {
      return {
        chips: [
          {
            id: 'read-nearest-sign',
            label: 'READ NEAREST',
            title: state.records.length
              ? 'Fly to the nearest sign and read its board'
              : 'No signs are currently posting',
            disabled: !state.enabled || !state.records.length,
            onClick: () => {
              const camera = state.viewer?.camera;
              if (!camera || !state.records.length) return;
              const here = camera.positionCartographic;
              const lat = Cesium.Math.toDegrees(here.latitude);
              const lon = Cesium.Math.toDegrees(here.longitude);
              let best = null;
              let bestD = Infinity;
              for (const record of state.records) {
                const d =
                  (record.lat - lat) ** 2 +
                  ((record.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
                if (d < bestD) {
                  bestD = d;
                  best = record;
                }
              }
              if (best) presentation.focusSign(best.id);
            },
          },
        ],
        legend: [
          {
            label: 'Message boards',
            color: Cesium.Color.fromCssColorString(BOARD_TEXT),
            count: state.records.length,
            blurb:
              'Live message boards, each facing the traffic it addresses. Zoom in to read the face; a multi-page board cycles.',
          },
        ],
      };
    },
  };
}
