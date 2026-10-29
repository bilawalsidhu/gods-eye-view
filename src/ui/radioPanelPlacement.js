import { MOBILE_SHELL_CLASS } from './mobileShellContract.js';

/**
 * Keep Radio in Context in every theme, reusing the same playback controls.
 * The compact launcher (the dock) sits in the right rail's tool slot under the
 * tab strip on desktop, where a collapsed Context is hidden, and in Context's
 * header on phones, where the sheet shows that header.
 */
export function syncRadioPanelPlacement(doc) {
  if (!doc?.getElementById) return;
  const panel = doc.getElementById('radio-panel');
  const context = doc.getElementById('global-context-panel');
  const dock = doc.getElementById('context-radio-dock');
  const mini = doc.getElementById('context-radio-mini');
  const parent =
    context?.querySelector('.cyber-panel-body') ||
    context?.querySelector('.global-context-panel-inner');
  const header = context?.querySelector('.panel-header');
  if (!panel || !parent || !header || !dock || !mini) return;
  if (panel.parentElement !== parent) parent.append(panel);
  const slot = doc.getElementById('right-rail-tools');
  const phone = Boolean(doc.body?.classList?.contains?.(MOBILE_SHELL_CLASS));
  if (slot && !phone) {
    if (dock.parentElement !== slot) slot.append(dock);
  } else if (dock.parentElement !== header) {
    header.insertBefore(dock, header.querySelector('.panel-collapse-btn'));
  }
  if (mini.parentElement !== dock) dock.append(mini);
}
