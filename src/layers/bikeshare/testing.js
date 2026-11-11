export function createTesting({ state: layerState, services, parts, source }) {
  /** Seed a selected-station runtime record while still exercising real select/clear paths. */

  function _setBikeshareSelectionStateForTest({ key, record, overlayHost }) {
    layerState._stationRenderMap = new Map([[key, record]]);
    record.index = 0;
    layerState._selectedKey = null;
    layerState._overlayHost = overlayHost || layerState.DEFAULT_OVERLAY_HOST;
  }

  /** Exercise the production selection path in focused runtime tests. */

  function _selectBikeshareStationForTest(key) {
    parts.display._selectStation(key);
  }

  /** Exercise the production clear path and restore the production host seam. */

  function _clearBikeshareSelectionForTest() {
    parts.display._clearSelection();
    layerState._overlayHost = layerState.DEFAULT_OVERLAY_HOST;
  }
  return {
    _setBikeshareSelectionStateForTest,
    _selectBikeshareStationForTest,
    _clearBikeshareSelectionForTest,
  };
}
