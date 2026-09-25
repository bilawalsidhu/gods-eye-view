import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import { noradIdFromSatnum } from './noradId.js';
import {
  DENSE_REFRESH_FRAMES,
  DENSE_GROUP_PATH,
  POINT_STYLES,
  DENSE_CREATE_CHUNK,
} from './policy.js';

export function createCatalog({ state: layerState, services, parts, source }) {
  function _abortActiveUpdates() {
    for (const controller of layerState._activeUpdateControllers)
      controller.abort();
    layerState._activeUpdateControllers.clear();
    layerState._denseLoadController?.abort();
    layerState._denseLoadController = null;
  }

  /**
   * Re-propagate a small per-frame slice of the dense extras (round-robin).
   * Budget: the full dense set completes one pass every ~DENSE_REFRESH_FRAMES
   * frames (~5s at 60fps ≈ 1/5 of the core cadence), so per-frame cost stays
   * ~35 propagations (~0.1 ms) even with 10K+ Starlink sats — spreading the
   * work per frame avoids the once-per-second spike a tick-sized chunk
   * (~2K props ≈ 4ms) would cause.
   */

  function _propagateDenseChunk() {
    if (layerState._denseIds.length === 0) return;
    const perFrame = Math.max(
      1,
      Math.ceil(layerState._denseIds.length / DENSE_REFRESH_FRAMES),
    );
    const now = new Date();
    for (let i = 0; i < perFrame; i++) {
      if (layerState._denseCursor >= layerState._denseIds.length)
        layerState._denseCursor = 0;
      const noradId = layerState._denseIds[layerState._denseCursor++];
      if (noradId === layerState._trackedNorad) continue; // per-frame tracked path owns it
      const sat = layerState._catalog.get(noradId);
      const point = layerState._points.get(noradId);
      if (!sat || !point) continue;
      const pos = parts.orbits.propagatePosition(sat.satrec, now);
      if (pos) {
        point.position = Cesium.Cartesian3.fromDegrees(
          pos.longitude,
          pos.latitude,
          pos.altitude,
        );
      }
    }
  }

  /**
   * Load the dense catalog extras (Starlink) as points-only satellites.
   * Chunked so ~10K twoline2satrec builds + initial propagations never block a
   * frame; a token guards against mode flips / catalog rebuilds mid-load.
   */

  async function _loadDenseCatalog({ signal = null } = {}) {
    if (!layerState._viewer || !layerState._pointCollection)
      return { status: 'source-unavailable', reason: 'layer-unavailable' };
    layerState._denseLoadController?.abort();
    const resourceController = new AbortController();
    layerState._denseLoadController = resourceController;
    const loadSignal = signal
      ? AbortSignal.any([signal, resourceController.signal])
      : resourceController.signal;
    const token = ++layerState._denseLoadToken;
    layerState._denseStatus = 'loading';
    layerState._denseError = null;
    parts.controls._notifyRowControls();
    try {
      loadSignal.throwIfAborted();
      const res = await source.readGroup(DENSE_GROUP_PATH, {
        signal: loadSignal,
      });
      if (!res.ok) {
        console.warn(
          `[Data:Satellites] Dense group '${DENSE_GROUP_PATH}' fetch failed (${res.status})`,
        );
        _denseLoadFailed(token, `feed unavailable (${res.status})`);
        return {
          status: 'source-unavailable',
          reason: `feed unavailable (${res.status})`,
        };
      }
      const text = res.text;
      loadSignal.throwIfAborted();
      if (
        token !== layerState._denseLoadToken ||
        layerState._params.catalog !== 'dense'
      ) {
        return { status: 'superseded', reason: 'dense-load-superseded' };
      }

      const entries = parts.orbits.parseTLE(text);
      const style = POINT_STYLES.dense;
      const now = new Date();
      let added = 0;

      for (let start = 0; start < entries.length; start += DENSE_CREATE_CHUNK) {
        loadSignal.throwIfAborted();
        if (
          token !== layerState._denseLoadToken ||
          layerState._params.catalog !== 'dense' ||
          !layerState._pointCollection
        ) {
          return { status: 'superseded', reason: 'dense-load-superseded' };
        }
        const end = Math.min(start + DENSE_CREATE_CHUNK, entries.length);
        for (let i = start; i < end; i++) {
          const entry = entries[i];
          const satrec = twoline2satrec(entry.line1, entry.line2);
          if (!satrec || satrec.error !== 0) continue;
          const noradId = noradIdFromSatnum(satrec.satnum);
          if (layerState._catalog.has(noradId)) continue; // core catalog keeps priority
          const pos = parts.orbits.propagatePosition(satrec, now);
          if (!pos) continue;

          layerState._catalog.set(noradId, {
            name: entry.name,
            satrec,
            group: 'dense',
          });
          const point = layerState._pointCollection.add({
            position: Cesium.Cartesian3.fromDegrees(
              pos.longitude,
              pos.latitude,
              pos.altitude,
            ),
            pixelSize: style.pixelSize,
            color: style.color,
            outlineColor: style.outlineColor,
            outlineWidth: style.outlineWidth,
            scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6),
            id: noradId,
          });
          layerState._points.set(noradId, point);
          layerState._denseIds.push(noradId);
          added++;
        }
        // Yield to the event loop between chunks.
        await new Promise((resolve) => setTimeout(resolve, 0));
        loadSignal.throwIfAborted();
      }

      // A 200 that yields nothing usable is still a failed load — an empty body,
      // an HTML error page the proxy passed through, or a feed of TLEs the core
      // catalog already owns. Treating it as success is the same lie as treating
      // a 502 as success, just through a different door.
      if (added === 0) {
        console.warn(
          `[Data:Satellites] Dense group '${DENSE_GROUP_PATH}' returned no usable satellites`,
        );
        _denseLoadFailed(token, 'feed returned no satellites');
        return {
          status: 'source-unavailable',
          reason: 'feed returned no satellites',
        };
      }

      layerState._count = layerState._points.size;
      layerState._catalogRevision++;
      layerState._denseStatus = 'ready';
      console.log(
        `[Data:Satellites] Dense catalog: +${added} ${DENSE_GROUP_PATH} (points only)`,
      );
      // The panel would otherwise keep the pre-load count and legend until the
      // next natural refresh — up to the 5-minute catalog interval.
      parts.controls._notifyRowControls();
      parts.tracking._applyPendingTrackingRestore();
      return { status: 'ready', added };
    } catch (e) {
      if (loadSignal.aborted || e?.name === 'AbortError') {
        return {
          status: 'cancelled',
          reason: String(loadSignal.reason || 'aborted'),
        };
      }
      console.warn('[Data:Satellites] Dense catalog load failed:', e);
      _denseLoadFailed(token, 'feed unreachable');
      return { status: 'source-unavailable', reason: 'feed unreachable' };
    } finally {
      if (layerState._denseLoadController === resourceController)
        layerState._denseLoadController = null;
    }
  }

  /**
   * Settle a failed dense load: drop any partial chunk, return the layer to the
   * core catalog, and leave the reason on the chip. Reverting the param is the
   * point — a chip that reads ACTIVE over an empty sky is a lie.
   * @param {number} token The load token that failed.
   * @param {string} reason Short operator-facing cause.
   */

  function _denseLoadFailed(token, reason) {
    // A newer load (or a mode flip) already owns the state — say nothing.
    if (token !== layerState._denseLoadToken) return;
    layerState._params.catalog = 'core';
    _removeDenseCatalog();
    layerState._denseStatus = 'failed';
    layerState._denseError = reason;
    parts.controls._notifyRowControls();
  }

  /** Remove all dense extras (catalog entries, points, tracking if needed). */

  function _removeDenseCatalog() {
    layerState._denseLoadController?.abort();
    layerState._denseLoadController = null;
    layerState._denseLoadToken++; // cancel any in-flight dense load
    if (
      layerState._trackedNorad !== null &&
      layerState._catalog.get(layerState._trackedNorad)?.group === 'dense'
    ) {
      parts.tracking._clearTracking();
    }
    for (const noradId of layerState._denseIds) {
      const point = layerState._points.get(noradId);
      if (point && layerState._pointCollection)
        layerState._pointCollection.remove(point);
      layerState._points.delete(noradId);
      layerState._catalog.delete(noradId);
    }
    layerState._denseIds = [];
    layerState._denseCursor = 0;
    layerState._count = layerState._points.size;
    layerState._catalogRevision++;
  }
  return {
    _abortActiveUpdates,
    _propagateDenseChunk,
    _loadDenseCatalog,
    _denseLoadFailed,
    _removeDenseCatalog,
  };
}
