import { normalizeMilitaryInstallations } from '../../data/militaryInstallationData.js';

export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { governorRequestRender } = services.render;
  const { resolveGroundFloorCellsBounded } = services.ground;

  /**
   * Commit a status/error transition and buy the one frame it needs.
   *
   * With the render governor idle — Contacts has released its hold and nothing
   * else animates — no frame would otherwise arrive to re-read this, so a load
   * that fails after the scene went quiet would leave the last healthy readout on
   * screen indefinitely.
   * @param {string} status @param {?string} error
   */

  function setInstallationStatus(status, error = null) {
    if (layerState.status === status && layerState.error === error) return;
    layerState.status = status;
    layerState.error = error;
    governorRequestRender('installations-status');
  }

  async function loadInstallations() {
    if (!layerState.enabled || !layerState.viewer) return;
    const box = parts.viewport.viewportBox(layerState.viewer);
    // Guidance, not a fault: the layer chose not to query because the view is
    // unbounded (a global view, or Cockpit looking at the horizon). Keep it out
    // of `error` — the manager derives refresh failures and the global status
    // chip derives LOAD FAILED from that field, and a "zoom in" prompt turned
    // every Cockpit refresh into a reported failure. The row and toast read the
    // prompt from `statusMessage` (installationFeedback) instead.
    if (!box) {
      layerState.abort?.abort();
      layerState.abort = null;
      layerState.loading = false;
      parts.viewport.clearUnavailableRetry();
      setInstallationStatus('zoom-in');
      return;
    }
    layerState.abort?.abort();
    const requestAbort = new AbortController();
    layerState.abort = requestAbort;
    layerState.loading = true;
    parts.viewport.clearUnavailableRetry({ resetBackoff: false });
    // The previous attempt's failure is not the outcome of this new attempt.
    setInstallationStatus('loading');
    try {
      const fetchInstallations = (exact) =>
        source.getMappedSites(box, { exact, signal: requestAbort.signal });

      let payload = await fetchInstallations(false);
      // A SATURATED snapped tile was truncated upstream, so features from the
      // snap's extra ring may have crowded out sites actually on screen. Re-ask
      // for the exact viewport (separately keyed and cached) before rendering.
      let saturated = parts.model.installationResponseSaturated(payload);
      if (saturated) {
        payload = await fetchInstallations(true);
        saturated = parts.model.installationResponseSaturated(payload);
      }
      const normalized = normalizeMilitaryInstallations(
        payload,
        payload.retrievedAt || new Date().toISOString(),
      );
      // The proxy answers a bbox at least as large as the viewport; keep only what
      // was actually asked for so nothing off-screen reaches the map or the
      // "current viewport only" context claim.
      const records = normalized.records.filter((record) =>
        parts.model.installationWithinViewport(record, box),
      );
      let placesError = null;
      if (layerState.googleSearchRequested) {
        layerState.googleSearchRequested = false;
        const latitude = (box.south + box.north) / 2;
        const longitude = (box.west + box.east) / 2;
        const radiusM = Math.min(
          50000,
          Math.max(
            1000,
            Math.round(
              Math.max(box.north - box.south, box.east - box.west) * 55_000,
            ),
          ),
        );
        try {
          const placesPayload = await source.searchNearby(
            { latitude, longitude, radiusM },
            { signal: requestAbort.signal },
          );
          const seen = new Set(
            records.map(
              (record) =>
                `${record.name.toLowerCase()}|${record.latitude.toFixed(3)}|${record.longitude.toFixed(3)}`,
            ),
          );
          for (const place of Array.isArray(placesPayload?.places)
            ? placesPayload.places
            : []) {
            if (
              !place?.id ||
              !place?.name ||
              !Number.isFinite(place.latitude) ||
              !Number.isFinite(place.longitude)
            )
              continue;
            const placeClass = parts.model.classifyGoogleMilitaryPlace(place);
            const signature = `${String(place.name).toLowerCase()}|${place.latitude.toFixed(3)}|${place.longitude.toFixed(3)}`;
            if (seen.has(signature)) continue;
            seen.add(signature);
            const retrievedAt = new Date().toISOString();
            records.push({
              id: `google:${place.id}`,
              kind:
                placeClass === 'military_land'
                  ? 'installation'
                  : 'place_candidate',
              class: placeClass,
              name: String(place.name).trim(),
              latitude: place.latitude,
              longitude: place.longitude,
              footprint: null,
              primaryType: place.primaryType || null,
              placeTypes: Array.isArray(place.types) ? place.types : [],
              sources: [
                { name: 'Google Maps Places', id: place.id, retrievedAt },
              ],
              validation: 'unreviewed',
              retrievedAt,
            });
          }
        } catch (error) {
          if (
            requestAbort.signal.aborted ||
            layerState.abort !== requestAbort ||
            !layerState.enabled ||
            error?.name === 'AbortError'
          )
            return;
          placesError =
            'Google Places search unavailable; showing mapped sites';
        }
      }
      await resolveGroundFloorCellsBounded(
        records.map((record) => ({
          lat: record.latitude,
          lon: record.longitude,
        })),
      );
      if (
        requestAbort.signal.aborted ||
        layerState.abort !== requestAbort ||
        !layerState.enabled
      )
        return;
      layerState.records = records;
      layerState.recordById = new Map(
        layerState.records.map((record) => [record.id, record]),
      );
      layerState.lastUpdate = Date.now();
      layerState.stale = payload.status === 'stale';
      // Even the exact-viewport retry can saturate in a dense area. Say so rather
      // than implying the view is completely surveyed.
      layerState.saturated = saturated;
      layerState.failureReason = null;
      parts.viewport.clearUnavailableRetry();
      setInstallationStatus(
        layerState.records.length
          ? layerState.stale
            ? 'stale'
            : 'ready'
          : 'empty',
        payload.status === 'stale'
          ? 'Serving cached mapped context'
          : saturated
            ? 'Too many mapped sites in view to list them all'
            : placesError,
      );
      parts.rendering.renderRecords();
      parts.rendering.warmInstallationFloors(layerState.records);
    } catch (error) {
      if (
        requestAbort.signal.aborted ||
        layerState.abort !== requestAbort ||
        !layerState.enabled ||
        error?.name === 'AbortError'
      )
        return;
      layerState.failureReason = error?.failureReason || 'unavailable';
      setInstallationStatus(
        'unavailable',
        error?.message || 'Installation context unavailable',
      );
      parts.viewport.scheduleUnavailableRetry();
    } finally {
      // An older aborted request must not clear a newer request's busy state.
      if (layerState.abort === requestAbort) {
        layerState.abort = null;
        layerState.loading = false;
      }
    }
  }
  const methods = {
    update() {
      return loadInstallations();
    },
  };

  return { setInstallationStatus, loadInstallations, methods };
}
