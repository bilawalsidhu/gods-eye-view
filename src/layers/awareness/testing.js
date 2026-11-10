export function createTesting({ state: layerState, services, parts, source }) {
  /** @returns {{historyKeys: string[], navigationVisitedKeys: string[], historyLength: number, navigationIndex: number, suppressedHistoryKey: string|null, pendingSelectionKey: string|null}} */

  function _getAwarenessNavigationStateForTest() {
    return {
      historyKeys: layerState.navigationHistory.map(parts.subject.subjectKey),
      navigationVisitedKeys: [...layerState.navigationVisited],
      historyLength: layerState.navigationHistory.length,
      navigationIndex: layerState.navigationIndex,
      suppressedHistoryKey: layerState.suppressedHistoryKey,
      pendingSelectionKey: layerState.pendingSelectionKey,
    };
  }
  /** @returns {number} How many result renders ran, published or not. */
  function _getAwarenessPanelRendersForTest() {
    return layerState.panelRenders;
  }
  return {
    _getAwarenessNavigationStateForTest,
    _getAwarenessPanelRendersForTest,
  };
}
