// Observations for COMMAND only. PanelChrome remains the sole owner of panel
// mutations, persistence and focus; an earlier successful call is not a lease
// on a panel after a later call opens its peer.
const PANEL_LABELS = Object.freeze({
  'pp-toggles': 'Display',
  'cctv-panel': 'CCTV',
  'street-level-panel': 'Street Level',
  'global-context-panel': 'Context',
  'weather-panel': 'Weather',
  'recent-imagery-panel': 'Recent Imagery',
});

export function readRightRailState(documentRef = globalThis.document) {
  const rail = documentRef?.getElementById('right-context-rail');
  // Older shells do not have the exclusive tab policy. Do not infer it.
  if (!rail?.getAttribute('data-rail-tabs')) return null;
  const panels = Object.keys(PANEL_LABELS)
    .map((id) => documentRef.getElementById(id))
    .filter((panel) => panel && panel.parentElement === rail && !panel.hidden);
  const mobile = documentRef.body.classList.contains('mobile-shell');
  return {
    layout: mobile ? 'mobile' : 'desktop',
    visible:
      !rail.hidden &&
      !documentRef.body.classList.contains('cockpit-mode') &&
      (!documentRef.defaultView?.getComputedStyle ||
        documentRef.defaultView.getComputedStyle(rail).display !== 'none'),
    openPanelIds: panels
      .filter((p) => !p.classList.contains('collapsed'))
      .map((p) => p.id),
    closedPanelIds: panels
      .filter((p) => p.classList.contains('collapsed'))
      .map((p) => p.id),
  };
}

export function rightRailReply(state) {
  if (!state) return null;
  if (!state.visible)
    return 'Panel commands ran, but the right rail is hidden in this view.';
  const label = (ids) => ids.map((id) => PANEL_LABELS[id]).join(', ');
  if (state.layout === 'mobile')
    return `Expanded panels: ${label(state.openPanelIds) || 'none'}. Closed panels: ${label(state.closedPanelIds) || 'none'}.`;
  if (state.openPanelIds.length > 1)
    return 'The right rail has more than one panel open; its exclusive state could not be confirmed.';
  return `Right rail: ${state.openPanelIds.length ? label(state.openPanelIds) + ' open' : 'no panel open'}.${state.closedPanelIds.length ? ' Closed: ' + label(state.closedPanelIds) + '.' : ''}`;
}
