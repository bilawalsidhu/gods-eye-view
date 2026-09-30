import { militaryOsmKey } from '../../data/militaryNames.js';
import { isUnavailableCapability } from '../../sources/capability.js';
/** Keep named point coverage until its matching polygon takes over. */
export function retainNamedHandoff(previous, records, box) {
  const named = new Map(
    previous.filter((r) => r.namedArea).map((r) => [r.id, r]),
  );
  const represented = new Set();
  const next = records.map((record) => {
    represented.add(record.id);
    for (const id of record.aliasIds || []) represented.add(id);
    for (const member of record.namedMembers || []) represented.add(member.id);
    for (const source of record.sources || []) {
      const key = militaryOsmKey(source.id);
      if (key) represented.add(`osm:military:${key}`);
    }
    const prior =
      named.get(record.id) ||
      (record.aliasIds || [])
        .map((id) => named.get(id))
        .filter(Boolean)
        .sort((a, b) => b.areaM2 - a.areaM2)[0];
    return !record.namedArea && prior
      ? {
          ...record,
          name: prior.name,
          namedArea: true,
          areaM2: prior.areaM2,
          class: prior.class,
        }
      : record;
  });
  for (const record of previous) {
    if (
      record.pointOnly &&
      record.namedArea &&
      !represented.has(record.id) &&
      record.longitude >= box.west &&
      record.longitude <= box.east &&
      record.latitude >= box.south &&
      record.latitude <= box.north
    )
      next.push(record);
  }
  return next;
}

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
    const { box, coverage } = parts.viewport.loadArea(layerState.viewer);
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
    const keyOwner = (layerState.cameraLoadOwner ??= {});
    layerState.abort = requestAbort;
    layerState.loading = true;
    parts.viewport.clearUnavailableRetry({ resetBackoff: false });
    // The previous attempt's failure is not the outcome of this new attempt.
    setInstallationStatus('loading');
    try {
      const fetchInstallations = (exact) =>
        source.getMappedSites(box, { exact, signal: requestAbort.signal });

      let payload = await fetchInstallations(false);
      // Map tiles carry military areas only at z9 and finer: a view too wide
      // for that is guidance, exactly like an unbounded view, never an empty
      // all-clear. Previously loaded sites stay on the map.
      if (payload.zoomIn) {
        if (
          requestAbort.signal.aborted ||
          layerState.abort !== requestAbort ||
          !layerState.enabled
        )
          return;
        parts.viewport.clearUnavailableRetry();
        setInstallationStatus('zoom-in');
        return;
      }
      // A SATURATED snapped tile was truncated upstream, so features from the
      // snap's extra ring may have crowded out sites actually on screen. Re-ask
      // for the exact viewport (separately keyed and cached) before rendering.
      let saturated = payload.saturated === true;
      if (saturated && !payload.tileSource) {
        payload = await fetchInstallations(true);
        saturated = payload.saturated === true;
      }
      // The proxy answers a bbox at least as large as the viewport; keep only what
      // was actually asked for so nothing off-screen reaches the map or the
      // "current viewport only" context claim.
      const records = payload.records.filter(
        (record) =>
          payload.wide || parts.model.installationWithinViewport(record, box),
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
      let floorTimer;
      await Promise.race([
        resolveGroundFloorCellsBounded(
          records
            .filter((record) => !record.pointOnly)
            .map((record) => ({
              lat: record.latitude,
              lon: record.longitude,
            })),
        ),
        new Promise((resolve) => {
          floorTimer = setTimeout(resolve, 120);
        }),
      ]).finally(() => clearTimeout(floorTimer));
      if (
        requestAbort.signal.aborted ||
        layerState.abort !== requestAbort ||
        !layerState.enabled
      )
        return;
      const publish = (payload, records) => {
        if (
          requestAbort.signal.aborted ||
          layerState.abort !== requestAbort ||
          !layerState.enabled
        )
          return;
        if (!payload.wide)
          records = retainNamedHandoff(layerState.records, records, box);
        layerState.namedInView =
          payload.namedInView ?? records.filter((r) => r.namedArea).length;
        layerState.wide = Boolean(payload.wide);
        layerState.records = records;
        layerState.recordById = new Map(
          layerState.records.map((record) => [record.id, record]),
        );
        layerState.lastUpdate = Date.now();
        layerState.coverage = coverage;
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
            ? `Serving cached mapped context · ${payload.records[0]?.retrievedAt || 'date unknown'}`
            : saturated
              ? 'Too many mapped sites in view to list them all'
              : placesError,
        );
        parts.rendering.renderRecords();
        parts.rendering.warmInstallationFloors(
          layerState.records.filter((r) => !r.pointOnly),
        );
      };
      publish(payload, records);
      payload.enrichment?.then((enriched) => {
        if (
          !enriched ||
          requestAbort.signal.aborted ||
          layerState.abort !== requestAbort ||
          !layerState.enabled
        )
          return;
        const named = enriched.records.filter((record) =>
          parts.model.installationWithinViewport(record, box),
        );
        publish(enriched, [
          ...named,
          ...records.filter((record) => record.id.startsWith('google:')),
        ]);
      });
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
      if (!isUnavailableCapability(error))
        parts.viewport.scheduleUnavailableRetry(error?.retryAfterMs);
    } finally {
      // An older aborted request must not clear a newer request's busy state.
      if (layerState.abort === requestAbort) {
        if (
          requestAbort.signal.aborted &&
          layerState.cameraLoadOwner === keyOwner
        )
          layerState.cameraLoadKey = null;
        // Keep ownership until superseded so late names cannot enrich an old view.
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
