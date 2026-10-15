import * as Cesium from 'cesium';
import { USGS_WATER_LAYER_ID, USGS_OBSERVATION_TTL_MS } from './config.js';
import {
  normalizeUsgsWaterSnapshot,
  waterCardDetails,
  waterUtc,
} from './records.js';
import { createUsgsWaterRenderer } from './renderer.js';

/** Own site grouping, local county/reading selection, acquisition and scene resources. */
export function createUsgsWaterLayer({
  source,
  rendererFactory = createUsgsWaterRenderer,
  overlayHost = null,
  picking = null,
  pointer = null,
  handlerFactory = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('USGS water requires a snapshot source');
  let viewer = null;
  let enabled = false;
  let destroyed = false;
  let snapshot = null;
  let request = null;
  let renderer = null;
  let handler = null;
  let error = null;
  let retryAt = null;
  let selectedId = null;
  let readingIndex = 0;
  let county = 'all';
  let rowControlsListener = null;
  const rows = () =>
    (snapshot?.records ?? []).filter(
      (site) => county !== 'bexar' || site.bexar,
    );
  const selected = () => rows().find((site) => site.id === selectedId);
  const notify = () => {
    rowControlsListener?.();
    viewer?.scene?.requestRender?.();
  };
  const clearSelection = () => {
    selectedId = null;
    readingIndex = 0;
    overlayHost?.clearSource(USGS_WATER_LAYER_ID);
  };

  function publishSelection() {
    const site = selected();
    if (!site || !enabled) {
      clearSelection();
      return;
    }
    readingIndex = Math.min(readingIndex, site.readings.length - 1);
    overlayHost?.setEntries(
      USGS_WATER_LAYER_ID,
      [
        {
          id: `${USGS_WATER_LAYER_ID}:${site.id}:card`,
          title: site.name,
          details: waterCardDetails(
            site,
            readingIndex,
            snapshot.fetchedAt,
            Boolean(error),
          ),
          position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat),
          accent: '#4fc3f7',
          selected: true,
          interactive: Boolean(openExternal),
          priority: Number.MAX_SAFE_INTEGER,
          gapPx: 15,
          verticalOnly: true,
          placement: 'above',
          ...(openExternal
            ? {
                accessibilityLabel: 'Open official USGS station',
                activate: () => {
                  openExternal(site.sourceUrl);
                  return true;
                },
              }
            : {}),
        },
      ],
      { cohortLimit: 1, collisionCapacity: 1, moving: false },
    );
    notify();
  }

  async function install(current, sites) {
    const next = rendererFactory({ viewer });
    current.renderer = next;
    try {
      await next.replace(sites);
      if (
        current.controller.signal.aborted ||
        request !== current ||
        !enabled
      ) {
        next.destroy();
        return false;
      }
      next.setVisible(true);
      renderer?.destroy();
      renderer = next;
      current.renderer = null;
      return true;
    } catch (failure) {
      next.destroy();
      throw failure;
    }
  }

  function installSelection() {
    if (!overlayHost || !handlerFactory || !picking || handler) return;
    handler = handlerFactory(viewer);
    handler.setInputAction((click) => {
      if (!enabled || (pointer && !pointer.isPointerFree())) return;
      const overlay = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
      );
      if (overlay) {
        if (
          overlay.sourceId === USGS_WATER_LAYER_ID &&
          selected() &&
          openExternal
        )
          openExternal(selected().sourceUrl);
        return;
      }
      const id = picking.resolvePickId(viewer.scene.pick(click.position));
      if (rows().some((site) => site.id === id)) {
        selectedId = id;
        readingIndex = 0;
        publishSelection();
      } else if (!id || !picking.isOwnedByOtherLayer(USGS_WATER_LAYER_ID, id)) {
        clearSelection();
        notify();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: USGS_WATER_LAYER_ID,
    name: 'San Antonio USGS Water',
    icon: '◉',
    source: 'U.S. Geological Survey',
    updateInterval: USGS_OBSERVATION_TTL_MS,
    statsRefreshInterval: 1000,
    init(nextViewer) {
      if (viewer || destroyed)
        throw new Error('USGS water cannot be initialized again');
      viewer = nextViewer;
    },
    enable() {
      if (!viewer || destroyed) return false;
      enabled = true;
      error = null;
      overlayHost?.setVisible?.(USGS_WATER_LAYER_ID, true);
      installSelection();
      notify();
    },
    disable() {
      enabled = false;
      request?.controller.abort();
      request?.renderer?.destroy();
      request = null;
      renderer?.destroy();
      renderer = null;
      handler?.destroy();
      handler = null;
      snapshot = null;
      clearSelection();
      overlayHost?.setVisible?.(USGS_WATER_LAYER_ID, false);
      notify();
    },
    async update(_viewer, { signal, force = false } = {}) {
      if (!enabled || destroyed) return false;
      signal?.throwIfAborted();
      request?.controller.abort();
      request?.renderer?.destroy();
      const current = { controller: new AbortController(), renderer: null };
      request = current;
      const abort = () => current.controller.abort(signal.reason);
      const releasePending = () => current.renderer?.destroy();
      signal?.addEventListener('abort', abort, { once: true });
      current.controller.signal.addEventListener('abort', releasePending, {
        once: true,
      });
      notify();
      try {
        const raw = await source.getSnapshot({
          signal: current.controller.signal,
          force,
        });
        if (
          current.controller.signal.aborted ||
          request !== current ||
          !enabled
        )
          return false;
        const next = normalizeUsgsWaterSnapshot(raw);
        const wanted = next.records.filter(
          (site) => county !== 'bexar' || site.bexar,
        );
        if (!(await install(current, wanted))) return false;
        snapshot = next;
        error = null;
        retryAt = null;
        publishSelection();
        return true;
      } catch (failure) {
        if (
          current.controller.signal.aborted ||
          request !== current ||
          !enabled
        )
          return false;
        error = failure?.message || 'USGS water unavailable';
        retryAt = failure?.retryAt ?? null;
        publishSelection();
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
        current.controller.signal.removeEventListener('abort', releasePending);
        if (request === current) request = null;
        notify();
      }
    },
    destroy() {
      layer.disable();
      destroyed = true;
      viewer = null;
      rowControlsListener = null;
    },
    /** Local UI filters never issue another provider request or claim full county coverage. */
    async setParams(params = {}) {
      if (destroyed) return;
      if (
        !request &&
        ['all', 'bexar'].includes(params.county) &&
        params.county !== county
      ) {
        const previousCounty = county;
        county = params.county;
        clearSelection();
        if (enabled && snapshot) {
          request?.controller.abort();
          request?.renderer?.destroy();
          const current = { controller: new AbortController(), renderer: null };
          request = current;
          try {
            await install(current, rows());
          } catch (failure) {
            county = previousCounty;
            error = failure?.message || 'USGS display unavailable';
          } finally {
            if (request === current) request = null;
          }
        }
      }
      const site = selected();
      if (site && Number.isInteger(params.readingStep)) {
        readingIndex =
          (readingIndex +
            (params.readingStep > 0 ? 1 : -1) +
            site.readings.length) %
          site.readings.length;
        publishSelection();
      }
      notify();
    },
    /** The application panel owns one refresh subscription for this layer. */
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    getRowControls() {
      const site = selected();
      return {
        chips: [
          {
            id: 'all',
            label: 'Area',
            active: county === 'all',
            disabled: Boolean(request),
            title: 'San Antonio-area rectangle, including neighboring counties',
            params: { county: 'all' },
          },
          {
            id: 'bexar',
            label: 'Bexar',
            active: county === 'bexar',
            disabled: Boolean(request),
            title: 'Bexar subset of this rectangle; not full county coverage',
            params: { county: 'bexar' },
          },
          {
            id: 'refresh',
            label: 'Refresh',
            disabled:
              Boolean(request) ||
              (Number.isFinite(retryAt) && Date.now() < retryAt),
            title: retryAt
              ? `Retry after ${waterUtc(retryAt)}`
              : 'Refresh latest USGS observations',
            onClick: () => layer.update(viewer, { force: true }),
          },
          ...(site && site.readings.length > 1
            ? [
                {
                  id: 'previous-reading',
                  label: '← Reading',
                  params: { readingStep: -1 },
                },
                {
                  id: 'next-reading',
                  label: `Reading ${readingIndex + 1}/${site.readings.length} →`,
                  params: { readingStep: 1 },
                },
              ]
            : []),
        ],
        legend: [
          {
            label: 'numeric reading sites',
            color: '#4fc3f7',
            count: rows().filter((site) => site.numericReadingCount > 0).length,
          },
          {
            label: 'no numeric readings',
            color: '#b0bec5',
            count: rows().filter((site) => site.numericReadingCount === 0)
              .length,
          },
        ],
        info: site
          ? `${site.name} · use Reading controls for each series`
          : 'Latest observations in a 24-hour query window · click a station',
        infoTitle:
          'USGS provisional data may be revised. Marker color is data availability, not flood danger. County/reading controls are local session selections.',
      };
    },
    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(0, Math.min(256, Math.floor(maxCount)))
        : 256;
      return rows()
        .slice(0, limit)
        .map((site) => ({
          id: site.id,
          name: site.name,
          lon: site.lon,
          lat: site.lat,
          county: site.county,
          siteType: site.siteType,
          readingCount: site.readings.length,
          numericReadingCount: site.numericReadingCount,
          provisional: site.provisional,
          readings: structuredClone(site.readings),
          sourceUrl: site.sourceUrl,
        }));
    },
    getStats() {
      const visible = rows();
      return {
        count: visible.length,
        totalCount: snapshot?.records.length ?? 0,
        readingCount: visible.reduce(
          (total, site) => total + site.readings.length,
          0,
        ),
        numericReadingCount: visible.reduce(
          (total, site) => total + site.numericReadingCount,
          0,
        ),
        countLabel: snapshot ? `${visible.length} sites` : '',
        lastUpdate: snapshot?.fetchedAt ?? null,
        windowStart: snapshot?.windowStart ?? null,
        windowEnd: snapshot?.windowEnd ?? null,
        excludedOldCount: snapshot?.excludedOldCount ?? 0,
        stale: Boolean(error && snapshot),
        loading: Boolean(request),
        error,
        retryAt,
        source: 'U.S. Geological Survey',
        coverage:
          county === 'bexar'
            ? 'Bexar subset · San Antonio-area rectangle'
            : 'San Antonio-area rectangle · neighboring counties included',
        selectedId,
        readingIndex,
        county,
      };
    },
  };
  return layer;
}
