/**
 * Keep one side panel open on desktop, and on phones put back the collapse
 * this applied, since a sheet shows several panels at once. The owner is the
 * most recently opened panel, then the one holding keyboard focus, then the
 * first. `accordion-collapsed` marks the collapse as presentation only, so
 * saved and shared preferences still report the panel as the user left it.
 * @param {object} options
 * @param {HTMLElement[]} options.panels The side's laid-out panels.
 * @param {boolean} options.enabled Whether the one-panel rule applies.
 * @param {string} [options.preferredPanelId] Most recently opened panel.
 * @param {Document} [options.documentRef] Document supplying keyboard focus.
 * @param {Function} options.onCollapse Present a panel's collapse:
 *   `(panel, {collapsed, auto})`.
 */
export function settleSideAccordion({
  panels,
  enabled,
  preferredPanelId,
  documentRef,
  onCollapse,
}) {
  if (!enabled) {
    for (const panel of panels) {
      if (!panel.classList.contains('accordion-collapsed')) continue;
      onCollapse(panel, { collapsed: false, auto: null });
    }
    return;
  }
  const expanded = panels.filter(
    (panel) => !panel.classList.contains('collapsed'),
  );
  const owner =
    expanded.find((panel) => panel.id === preferredPanelId) ||
    expanded.find((panel) => panel.contains(documentRef?.activeElement)) ||
    expanded[0];
  for (const panel of expanded) {
    if (panel === owner) continue;
    onCollapse(panel, { collapsed: true, auto: 'accordion' });
  }
}
