// COMMAND-only readback. Do not enlarge the pinned Realtime tool payload.
const LABELS = Object.freeze({
  'data-panel': 'Data Layers',
  'utilities-panel': 'Utilities',
});

export function menuPanelOutcome(
  result,
  args,
  documentRef = globalThis.document,
) {
  const label = LABELS[result?.panelId];
  const panel = label && documentRef?.getElementById(result.panelId);
  let visible = Boolean(panel);
  for (let node = panel; node; node = node.parentElement) {
    const style = documentRef.defaultView?.getComputedStyle?.(node);
    if (
      node.hidden ||
      style?.display === 'none' ||
      style?.visibility === 'hidden'
    )
      visible = false;
  }
  const requested = args?.layerId || args?.layer;
  const focused = !requested || result?.focusedLayer?.id === requested;
  const ok = Boolean(
    result?.ok === true &&
    !result.cancelled &&
    result.applied !== false &&
    visible &&
    !panel.classList.contains('collapsed') &&
    focused,
  );
  return {
    ok,
    content: ok
      ? `${label} is open.${result.focusedLayer?.id === 'directions' ? ' Directions controls are available there.' : ''}`
      : 'The requested controls could not be confirmed open. No further actions were run for this request.',
  };
}
