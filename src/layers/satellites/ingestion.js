import { twoline2satrec } from 'satellite.js';
import * as Cesium from 'cesium';
import { CATALOG_GROUPS, ISS_NORAD, POINT_STYLES } from './policy.js';

/**
 * Fold the per-group provider statuses of one refresh into the layer's view:
 *   status      'stale' if ANY loaded group was served stale (proxy cache past
 *               TTL or the bundled snapshot), else 'degraded' if any loaded
 *               group said so, else 'live' when at least one loaded group
 *               reported; null when no loaded group carried a status.
 *   error       first non-null provider error (loaded groups first, then the
 *               failed ones, so a partial outage still names its cause).
 *   fetchedAtMs OLDEST data-fetch time among the loaded groups.
 *   source      first provider source label among the loaded groups.
 * @param {Array<{ok:boolean, provider:object|null, error?:string|null}>} results
 */
export function summarizeProviderStatus(results) {
  const loaded = results.filter((r) => r.ok);
  const reported = loaded.map((r) => r.provider).filter(Boolean);
  let status = null;
  if (reported.some((p) => p.status === 'stale')) status = 'stale';
  else if (reported.some((p) => p.status === 'degraded')) status = 'degraded';
  else if (reported.length) status = 'live';
  const firstError = (rows) =>
    rows.map((r) => r.error || r.provider?.error || null).find(Boolean) || null;
  const fetchedAts = reported
    .map((p) => p.fetchedAtMs)
    .filter((ms) => Number.isFinite(ms));
  return {
    status,
    error: firstError(loaded) || firstError(results.filter((r) => !r.ok)),
    fetchedAtMs: fetchedAts.length ? Math.min(...fetchedAts) : null,
    source: reported.map((p) => p.source).find(Boolean) || null,
  };
}

export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  const methods = {
    async update(viewer, { signal = null } = {}) {
      const trackingRefreshEpoch = ++layerState._trackingRefreshEpoch;
      layerState._lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'source-unavailable',
        failedGroups: [],
      };
      const resourceController = new AbortController();
      layerState._activeUpdateControllers.add(resourceController);
      const updateSignal = signal
        ? AbortSignal.any([signal, resourceController.signal])
        : resourceController.signal;
      try {
        updateSignal.throwIfAborted();
        // Load all core groups in parallel; a failed/empty group degrades
        // gracefully (parseTLE of an upstream error body yields []).
        const results = await Promise.all(
          CATALOG_GROUPS.map(async (groupDef) => {
            try {
              const res = await source.readGroup(groupDef.path, {
                signal: updateSignal,
              });
              const provider = res.provider || null;
              if (!res.ok)
                return {
                  ...groupDef,
                  entries: [],
                  ok: false,
                  provider,
                  error: res.error || provider?.error || null,
                };
              const entries = parts.orbits.parseTLE(res.text);
              updateSignal.throwIfAborted();
              return {
                ...groupDef,
                entries,
                ok: entries.length > 0,
                provider,
                error: provider?.error || null,
              };
            } catch (error) {
              if (updateSignal.aborted || error?.name === 'AbortError')
                throw error;
              return {
                ...groupDef,
                entries: [],
                ok: false,
                provider: null,
                error: null,
              };
            }
          }),
        );
        updateSignal.throwIfAborted();

        const failed = results.filter((r) => !r.ok).map((r) => r.path);
        const provided = summarizeProviderStatus(results);
        if (failed.length > 0) {
          console.warn(
            `[Data:Satellites] Groups failed or empty: ${failed.join(', ')}`,
          );
        }
        console.log(
          `[Data:Satellites] Loaded ${results.map((r) => `${r.tag}:${r.entries.length}`).join(' ')}`,
        );

        // CelesTrak outage guard (H3): if EVERY group failed, bail BEFORE clearing.
        // Wiping the collection + catalog here would blank all 838 satellites while
        // the chip still read "just now". Keep the existing (stale) catalog on
        // screen and surface the outage instead — do NOT stamp _lastUpdate.
        if (results.every((r) => !r.ok)) {
          layerState._lastError = 'CelesTrak unreachable';
          // The proxy's own reason (e.g. "CelesTrak HTTP 403 — no cached TLEs")
          // is kept for diagnostics; the provider state of the catalog still on
          // screen (if any) is left as it was — it describes THAT data.
          if (provided.error) layerState._providerError = provided.error;
          console.warn(
            '[Data:Satellites] All CelesTrak groups failed — keeping existing catalog, surfacing outage',
          );
          // Re-apply dense mode is skipped (no fresh core catalog); tracking untouched.
          return;
        }

        // At least one group loaded — proceed with a fresh rebuild, but keep the
        // partial outage visible at the layer control instead of presenting the
        // reduced catalog as a fully healthy refresh.
        layerState._lastError = failed.length
          ? `${failed.length} CelesTrak group${failed.length === 1 ? '' : 's'} unavailable`
          : null;
        // Provider state of the catalog being built: STALE if ANY loaded group
        // came from the proxy's stale cache or the bundled snapshot, with the
        // OLDEST data-fetch time so the row's age is honest.
        layerState._providerStatus = provided.status;
        layerState._providerError = provided.error;
        layerState._providerFetchedAt = provided.fetchedAtMs;
        layerState._providerSource = provided.source;
        if (provided.status === 'stale') {
          console.warn(
            `[Data:Satellites] Catalog served stale by the proxy (${provided.source || 'cache'})${provided.error ? ` — ${provided.error}` : ''}`,
          );
        }

        // Clear existing
        layerState._pointCollection.removeAll();
        layerState._points.clear();
        for (const path of layerState._orbitPaths.values())
          viewer.scene.primitives.remove(path.primitive);
        layerState._orbitPaths.clear();
        layerState._catalog.clear();
        // The detection overlay caches one record per satellite and stamps its
        // id/class at creation only. A rebuild can re-tag a satellite (a failed
        // group shifts which one wins dedupe), so the cache must go with the
        // catalog or those labels stay stale for the life of the session.
        layerState._detectionObjects.clear();
        layerState._denseIds = [];
        layerState._denseCursor = 0;
        layerState._denseLoadController?.abort();
        layerState._denseLoadController = null;
        layerState._denseLoadToken++; // cancel any in-flight dense load against the old catalog
        parts.labels._syncIssOverlay();

        const now = new Date();

        // Process all TLE entries in CATALOG_GROUPS order
        const allEntries = [];
        for (const r of results) {
          for (const e of r.entries) allEntries.push({ ...e, group: r.tag });
        }

        // Deduplicate by NORAD ID — first (most specific) group tag wins
        const seen = new Set();

        for (const entry of allEntries) {
          const satrec = twoline2satrec(entry.line1, entry.line2);
          if (!satrec || satrec.error !== 0) continue;

          const noradId = Number(satrec.satnum);
          if (seen.has(noradId)) continue;
          seen.add(noradId);

          // Store in catalog
          layerState._catalog.set(noradId, {
            name: entry.name,
            satrec,
            group: entry.group,
          });

          // Propagate initial position
          const pos = parts.orbits.propagatePosition(satrec, now);
          if (!pos) continue;

          const cartesian = Cesium.Cartesian3.fromDegrees(
            pos.longitude,
            pos.latitude,
            pos.altitude,
          );

          // Add point primitive (styling from the shared table, WS-D3)
          const style = parts.controls._pointStyleFor(noradId, entry.group);
          const point = layerState._pointCollection.add({
            position: cartesian,
            pixelSize: style.pixelSize,
            color: style.color,
            outlineColor: style.outlineColor,
            outlineWidth: style.outlineWidth,
            scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6),
            id: noradId,
          });

          layerState._points.set(noradId, point);
        }

        // Show ISS orbital path by default
        if (layerState._catalog.has(ISS_NORAD)) {
          parts.rendering._showOrbitPath(ISS_NORAD, POINT_STYLES.iss.color);
          const issPath = layerState._orbitPaths.get(ISS_NORAD);
          if (issPath) issPath.primitive.show = layerState._params.showOrbits;

          parts.labels._syncIssOverlay();
        }

        layerState._count = layerState._points.size;
        layerState._catalogRevision++;
        layerState._lastUpdate = Date.now();
        layerState._lastPropagation = Date.now();
        layerState._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: failed.length ? 'partial' : 'accepted',
          failedGroups: [...failed],
        };
        console.log(
          `[Data:Satellites] ${layerState._count} satellites active, ISS path shown`,
        );

        // Re-apply dense mode after a full catalog rebuild (fire-and-forget —
        // _loadDenseCatalog handles its own errors and token invalidation).
        layerState._denseLoadPromise =
          layerState._params.catalog === 'dense'
            ? parts.catalog._loadDenseCatalog({ signal: updateSignal })
            : Promise.resolve({ status: 'not-requested' });
        // The catalog the published voice subject was resolved against is gone.
        // Re-resolve it, or release the slot if the subject provably did not
        // survive. Deliberately not awaited: it waits on dense settlement, and
        // the rebuild must not block on that.
        void parts.tracking._reconcileTrackedSubjectContext();
        parts.tracking._applyPendingTrackingRestore();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Satellite update aborted', 'AbortError');
        }
        console.warn('[Data:Satellites] Fetch error:', e);
      } finally {
        layerState._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}
