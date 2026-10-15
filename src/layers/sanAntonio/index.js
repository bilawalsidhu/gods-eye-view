import * as Cesium from 'cesium';
import {
  SAN_ANTONIO_ATTRIBUTION,
  SAN_ANTONIO_CACHE_TTL_MS,
  getSanAntonioDataset,
} from './config.js';
import { normalizeSanAntonioSnapshot } from './records.js';
import { createSanAntonioRenderer } from './renderer.js';

export { SAN_ANTONIO_DATASETS, getSanAntonioDataset } from './config.js';

const CARD_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

const dateLabel = (time) =>
  Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : 'unknown';

/** Own one City collection's acquisition, selection and display lifetime. */
export function createSanAntonioLayer({
  dataset,
  source,
  rendererFactory = createSanAntonioRenderer,
  overlayHost = null,
  picking = null,
  pointer = null,
  screenSpaceEventHandlerFactory = null,
  openExternal = null,
} = {}) {
  dataset = getSanAntonioDataset(dataset?.id ?? dataset);
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('San Antonio layers require a snapshot source');

  let viewer = null;
  let enabled = false;
  let destroyed = false;
  let renderer = null;
  let request = null;
  let snapshot = null;
  let snapshotSignature = null;
  let error = null;
  let selectedId = null;
  let handler = null;
  const rowsById = new Map();

  function publishSelection() {
    if (!overlayHost) return;
    const row = rowsById.get(selectedId);
    if (!row || !enabled) {
      selectedId = null;
      overlayHost.setEntries(dataset.id, [], CARD_OPTIONS);
      return;
    }
    const details = [
      ...row.details,
      `Source data edited ${dateLabel(snapshot?.sourceUpdatedAt)} (UTC)`,
      'City of San Antonio · mapped reference data',
      ...(openExternal ? ['City dataset ↗ · click card to open'] : []),
    ];
    overlayHost.setEntries(
      dataset.id,
      [
        {
          id: `${row.id}:card`,
          title: row.name,
          details,
          position: Cesium.Cartesian3.fromDegrees(
            row.anchor.lon,
            row.anchor.lat,
          ),
          accent: dataset.color,
          selected: true,
          interactive: Boolean(openExternal),
          priority: Number.MAX_SAFE_INTEGER,
          gapPx: 15,
          verticalOnly: true,
          placement: 'above',
          ...(openExternal
            ? {
                accessibilityLabel: `Open ${dataset.name} source dataset`,
                activate: () => {
                  openExternal(dataset.datasetUrl);
                  return true;
                },
              }
            : {}),
        },
      ],
      CARD_OPTIONS,
    );
    viewer?.scene?.requestRender?.();
  }

  function installSelection() {
    if (!overlayHost || !picking || !screenSpaceEventHandlerFactory || handler)
      return;
    handler = screenSpaceEventHandlerFactory(viewer);
    // Do not claim large ground shapes in the shared ownership registry:
    // sibling overlay cards must remain clickable above a park or trail.
    handler.setInputAction((click) => {
      if (!enabled || (pointer && !pointer.isPointerFree())) return;
      const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y);
      if (hit) {
        if (hit.sourceId === dataset.id && openExternal)
          openExternal(dataset.datasetUrl);
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const id = picking.resolvePickId(picked);
      if (rowsById.has(id)) {
        selectedId = id;
        publishSelection();
      } else if (!id || !picking.isOwnedByOtherLayer(dataset.id, id)) {
        selectedId = null;
        publishSelection();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function releaseDisplay() {
    renderer?.destroy();
    renderer = null;
    handler?.destroy();
    handler = null;
    selectedId = null;
    rowsById.clear();
    snapshot = null;
    snapshotSignature = null;
    overlayHost?.clearSource(dataset.id);
    overlayHost?.setVisible?.(dataset.id, false);
    viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: dataset.id,
    name: dataset.name,
    icon: dataset.icon,
    source: SAN_ANTONIO_ATTRIBUTION,
    updateInterval: SAN_ANTONIO_CACHE_TTL_MS,

    init(nextViewer) {
      if (viewer || destroyed)
        throw new Error('San Antonio layer cannot be initialized again');
      viewer = nextViewer;
    },

    enable() {
      if (!viewer || destroyed) return false;
      enabled = true;
      error = null;
      overlayHost?.setVisible?.(dataset.id, true);
      installSelection();
    },

    disable() {
      enabled = false;
      request?.controller.abort();
      request = null;
      releaseDisplay();
    },

    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      signal?.throwIfAborted();
      request?.controller.abort();
      const current = { controller: new AbortController() };
      request = current;
      const cancel = () => current.controller.abort(signal.reason);
      const releasePending = () => current.renderer?.destroy();
      signal?.addEventListener('abort', cancel, { once: true });
      current.controller.signal.addEventListener('abort', releasePending, {
        once: true,
      });
      try {
        const raw = await source.getSnapshot({
          datasetId: dataset.id,
          signal: current.controller.signal,
        });
        if (
          current.controller.signal.aborted ||
          request !== current ||
          !enabled
        )
          return false;
        const next = normalizeSanAntonioSnapshot(raw, dataset);
        if (next.sourceCount > 0 && next.records.length === 0)
          throw new Error('No usable geometry in the San Antonio dataset');
        // The source protects its cache by cloning results. Compare bounded
        // normalized content, not object identity, before rebuilding graphics.
        const signature = JSON.stringify(next.records);
        if (signature !== snapshotSignature || !renderer) {
          // Build off to the side. A failed replacement leaves the last complete
          // display intact and reports it as stale instead of clearing the map.
          const nextRenderer = rendererFactory({ viewer, dataset });
          current.renderer = nextRenderer;
          try {
            await nextRenderer.replace(next.records);
            if (
              current.controller.signal.aborted ||
              request !== current ||
              !enabled
            ) {
              nextRenderer.destroy();
              return false;
            }
            nextRenderer.setVisible(true);
          } catch (failure) {
            nextRenderer.destroy();
            throw failure;
          }
          renderer?.destroy();
          renderer = nextRenderer;
          current.renderer = null;
          snapshot = next;
          snapshotSignature = signature;
          rowsById.clear();
          for (const row of next.records) rowsById.set(row.id, row);
        } else {
          // New source dates can accompany unchanged geometry. Keep the already
          // rendered records while advancing metadata without a second copy.
          snapshot = { ...next, records: snapshot.records };
        }
        error = null;
        if (selectedId) publishSelection();
        viewer?.scene?.requestRender?.();
        return true;
      } catch (failure) {
        if (
          current.controller.signal.aborted ||
          request !== current ||
          !enabled
        )
          return false;
        error = failure?.message || 'San Antonio source unavailable';
        return false;
      } finally {
        signal?.removeEventListener('abort', cancel);
        current.controller.signal.removeEventListener('abort', releasePending);
        if (request === current) request = null;
      }
    },

    destroy() {
      layer.disable();
      viewer = null;
      destroyed = true;
      error = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!enabled || !snapshot) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(0, Math.min(10000, Math.floor(maxCount)))
        : 2000;
      return snapshot.records.slice(0, limit).map((row) => ({
        id: row.id,
        name: row.name,
        objectId: row.objectId,
        lon: row.anchor.lon,
        lat: row.anchor.lat,
      }));
    },

    getRowControls() {
      return {
        chips: [],
        legend: [
          {
            label: dataset.countLabel,
            color: dataset.color,
            count: snapshot?.records.length ?? 0,
            blurb: [
              dataset.description,
              `Source data edited ${dateLabel(snapshot?.sourceUpdatedAt)} (UTC).`,
              ...(snapshot?.skippedCount
                ? [`${snapshot.skippedCount} invalid features omitted.`]
                : []),
            ].join(' '),
          },
        ],
      };
    },

    getStats() {
      return {
        count: snapshot?.records.length ?? 0,
        lastUpdate: snapshot?.fetchedAt ?? null,
        sourceUpdatedAt: snapshot?.sourceUpdatedAt ?? null,
        sourceCount: snapshot?.sourceCount ?? 0,
        skippedCount: snapshot?.skippedCount ?? 0,
        partial: (snapshot?.skippedCount ?? 0) > 0,
        loading: Boolean(request),
        stale: Boolean(error && snapshot),
        error,
        source: SAN_ANTONIO_ATTRIBUTION,
        sourceUrl: dataset.datasetUrl,
        selectedId,
      };
    },
  };
  return layer;
}
