/** Move the same controls without changing playback or subscriptions. */
export function syncRadioPanelPlacement(doc) {
  if (!doc?.getElementById) return;
  const panel = doc.getElementById('radio-panel');
  const context = doc.getElementById('global-context-panel');
  const rail = doc.getElementById('right-context-rail');
  const dock = doc.getElementById('context-radio-dock');
  const mini = doc.getElementById('context-radio-mini');
  const cyber = doc.documentElement?.dataset.uiTheme === 'cyber';
  const parent = cyber
    ? rail
    : context?.querySelector('.global-context-panel-inner');
  const header = (cyber ? panel : context)?.querySelector('.panel-header');
  if (!panel || !parent || !header || !dock || !mini) return;
  if (panel.parentElement !== parent) parent.append(panel);
  if (dock.parentElement !== header)
    header.insertBefore(dock, header.querySelector('.panel-collapse-btn'));
  const miniParent = cyber ? panel : dock;
  if (mini.parentElement !== miniParent) miniParent.append(mini);
}
