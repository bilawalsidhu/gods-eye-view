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
   * With the render governor idle nothing else would re-read this, so a load
   * that fails after the scene went quiet would leave the last healthy readout
   * on screen indefinitely.
   * @param {string} status Layer status.
   * @param {?string} error Presented error, or null.
   * @returns {void}
   */

  function setWaterQualityStatus(status, error = null) {
    if (layerState.status === status && layerState.error === error) return;
    layerState.status = status;
    layerState.error = error;
    governorRequestRender('water-quality-status');
  }

  async function loadSites() {
    if (!layerState.enabled || !layerState.viewer) return;
    const box = parts.viewport.viewportBox(layerState.viewer);
    // Guidance, not a fault: the layer chose not to query because the view is
    // unbounded. Keep it out of `error` — the manager derives refresh failures
    // from that field and a "zoom in" prompt is not a failure.
    if (!box) {
      layerState.abort?.abort();
      layerState.abort = null;
      layerState.loading = false;
      parts.viewport.clearUnavailableRetry();
      setWaterQualityStatus('zoom-in');
      return;
    }
    layerState.abort?.abort();
    const requestAbort = new AbortController();
    layerState.abort = requestAbort;
    layerState.loading = true;
    parts.viewport.clearUnavailableRetry({ resetBackoff: false });
    // The previous attempt's failure is not the outcome of this new attempt.
    setWaterQualityStatus('loading');
    const family = layerState.family;
    try {
      const payload = await source.getStations(box, {
        family,
        sinceYears: layerState.windowYears,
        signal: requestAbort.signal,
      });
      // The proxy answers a bbox at least as large as the viewport; keep only
      // what was asked for so nothing off-screen reaches the map.
      const records = parts.model
        .toRecords(payload.sites, family)
        .filter((record) => parts.model.siteWithinViewport(record, box));
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
        records.map((record) => [record.id, record]),
      );
      layerState.lastUpdate = Date.now();
      layerState.stale = payload.status === 'stale';
      layerState.saturated = payload.saturated === true;
      layerState.totalSiteCount = payload.totalSiteCount;
      layerState.sampledSince = payload.sampledSince;
      layerState.failureReason = null;
      parts.viewport.clearUnavailableRetry();
      setWaterQualityStatus(
        records.length ? (layerState.stale ? 'stale' : 'ready') : 'empty',
        payload.status === 'stale'
          ? 'Serving cached monitoring sites'
          : layerState.saturated
            ? 'More monitoring sites in view than can be listed'
            : null,
      );
      parts.rendering.renderRecords();
      parts.rendering.warmSiteFloors(records);
    } catch (error) {
      if (
        requestAbort.signal.aborted ||
        layerState.abort !== requestAbort ||
        !layerState.enabled ||
        error?.name === 'AbortError'
      )
        return;
      layerState.failureReason = error?.failureReason || 'unavailable';
      setWaterQualityStatus(
        'unavailable',
        error?.message || 'Water quality monitoring data unavailable',
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

  /**
   * Fetch one site's measurements for its card.
   *
   * Deliberately lazy and separately cancellable: result queries are far heavier
   * than the site query, so they are spent only on a site somebody selected, and
   * a camera move that aborts site loading must not tear down a card fetch the
   * operator is waiting on.
   * @param {string} siteId Monitoring site identifier.
   * @returns {Promise<void>} Resolves once the card state settles.
   */

  async function loadMeasurements(siteId) {
    if (!layerState.enabled || !siteId) return;
    if (layerState.measurementsBySite.has(siteId)) {
      governorRequestRender('water-quality-card');
      return;
    }
    layerState.measurementsAbort?.abort();
    const requestAbort = new AbortController();
    layerState.measurementsAbort = requestAbort;
    layerState.measurementsLoading = true;
    layerState.measurementsError = null;
    governorRequestRender('water-quality-card');
    try {
      const payload = await source.getResults(siteId, {
        family: layerState.family,
        sinceYears: layerState.windowYears,
        signal: requestAbort.signal,
      });
      if (
        requestAbort.signal.aborted ||
        layerState.measurementsAbort !== requestAbort ||
        !layerState.enabled
      )
        return;
      layerState.measurementsBySite.set(siteId, payload.measurements);
      parts.rendering.renderRecords();
    } catch (error) {
      if (
        requestAbort.signal.aborted ||
        layerState.measurementsAbort !== requestAbort ||
        !layerState.enabled ||
        error?.name === 'AbortError'
      )
        return;
      layerState.measurementsError =
        error?.message || 'Measurements unavailable for this site';
    } finally {
      if (layerState.measurementsAbort === requestAbort) {
        layerState.measurementsAbort = null;
        layerState.measurementsLoading = false;
        governorRequestRender('water-quality-card');
      }
    }
  }

  const methods = {
    update() {
      return loadSites();
    },
  };

  return { setWaterQualityStatus, loadSites, loadMeasurements, methods };
}
