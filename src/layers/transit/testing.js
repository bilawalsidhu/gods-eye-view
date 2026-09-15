/** Seams for the offline suite and the browser harness; nothing here is used in production paths. */
export function createTesting({ state: layerState, parts }) {
  return {
    /** Swap the shared overlay host (null restores the production host). */
    _setTransitOverlayHostForTest(host) {
      layerState._overlayHost = host || layerState.DEFAULT_OVERLAY_HOST;
    },
    /** Replace the clock the glide and staleness read. */
    _setTransitClockForTest(now) {
      layerState._now = typeof now === 'function' ? now : () => Date.now();
    },
    /** Run one animation frame at `now`. */
    _advanceTransitForTest(now) {
      parts.rendering.advance(now);
    },
    /** Drive a click with a synthetic pick result. */
    _handleTransitClickForTest(picked) {
      return parts.selection.handleClick(picked);
    },
    /** Snapshot of every drawn vehicle: key, mode, drawn lon/lat, shown. */
    _transitVehiclesForTest() {
      return [...layerState._vehicles.values()].map((entry) => ({
        key: entry.key,
        feedId: entry.feedId,
        mode: entry.mode,
        floorM: entry.floorM,
        shown: entry.point?.show !== false,
        position: entry.point?.position ? { ...entry.point.position } : null,
        from: entry.from,
        to: entry.to,
      }));
    },
    _transitSelectedKeyForTest() {
      return layerState._selectedKey;
    },
  };
}
