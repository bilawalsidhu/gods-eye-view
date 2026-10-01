export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { governorRequestRender } = services.render;

  function setStatus(status, error = null) {
    if (layerState.status === status && layerState.error === error) return;
    layerState.status = status;
    layerState.error = error;
    governorRequestRender('temperature-status');
  }

  /**
   * Find the newest published month and play its year.
   *
   * Runs once on enable rather than per camera move: the frames are global
   * tiled products and Cesium streams whatever the camera needs. The only
   * thing to discover is which months exist.
   * @returns {Promise<void>} Resolves once playback settles.
   */
  async function loadLatestYear() {
    if (!layerState.enabled || !layerState.viewer) return;
    layerState.abort?.abort();
    const requestAbort = new AbortController();
    layerState.abort = requestAbort;
    layerState.loading = true;
    setStatus('loading');
    const current = () =>
      !requestAbort.signal.aborted &&
      layerState.abort === requestAbort &&
      layerState.enabled;
    try {
      const { date } = await source.resolveLatest({
        signal: requestAbort.signal,
      });
      if (!current()) return;
      layerState.latest = date;
      const shown = await parts.playback.selectYear(Number(date.slice(0, 4)));
      if (!current()) return;
      if (!shown) throw new Error('Surface temperature frames did not load');
      layerState.lastUpdate = Date.now();
      layerState.failureReason = null;
      setStatus('ready');
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return;
      layerState.failureReason = error?.failureReason || 'unavailable';
      parts.playback.release();
      setStatus(
        'unavailable',
        error?.message || 'Surface temperature imagery unavailable',
      );
    } finally {
      if (layerState.abort === requestAbort) {
        layerState.abort = null;
        layerState.loading = false;
      }
    }
  }

  const methods = {
    update() {
      // Already playing; nothing to re-fetch per tick.
      if (layerState.filmstrip && layerState.status === 'ready') return;
      return loadLatestYear();
    },
  };

  return { setStatus, loadLatestYear, methods };
}
