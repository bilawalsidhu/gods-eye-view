/** Cyber keeps the frame fixed; other layouts retain their existing scroller. */
export function displayPanelScroller(panel) {
  return panel?.ownerDocument?.documentElement?.dataset.uiTheme === 'cyber'
    ? panel.querySelector('.pp-panel-body') || panel
    : panel;
}
