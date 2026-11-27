export function createTesting({ parts }) {
  /** Test seam that exercises the real selection/deselection path. */
  function _setSelectedRocketMissionForTest(launchId = null) {
    parts.selection.setSelectedMission(launchId, Boolean(launchId));
  }
  return { _setSelectedRocketMissionForTest };
}
