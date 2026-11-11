export function createTesting({ state: layerState, services, parts, source }) {
  /** Test seam for real layer lifecycle coverage with a recording host. */

  function _setRocketMissionOverlayHostForTest(host = null) {
    layerState._missionOverlayHost = host
      ? { ...layerState.DEFAULT_OVERLAY_HOST, ...host }
      : layerState.DEFAULT_OVERLAY_HOST;
  }

  /** Test seam that exercises the real selection/deselection path. */

  function _setSelectedRocketMissionForTest(launchId = null) {
    parts.selection.setSelectedMission(launchId, Boolean(launchId));
  }
  /** Test seam: the layer's record of one drawn element, by pick id. */

  function _missionElementForTest(id) {
    return layerState._missionElements.get(id) ?? null;
  }
  return {
    _setRocketMissionOverlayHostForTest,
    _setSelectedRocketMissionForTest,
    _missionElementForTest,
  };
}
