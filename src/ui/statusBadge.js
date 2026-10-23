/**
 * Ordinary read-only badge view. Labels are already translated. Feature owners
 * retain status derivation, machine-state attributes and announcement policy.
 * No listeners, timers, state inference or automatic live regions are installed.
 * Vue can replace this DOM adapter while retaining the label/hidden contract
 * and the gev-status-badge CSS surface.
 * @param {object} options
 * @param {Document} [options.documentRef]
 * @param {string} [options.label]
 * @param {'pill'|'box'|'plain'} [options.appearance]
 * @param {string} [options.className] Feature/layout hooks.
 * @param {boolean} [options.hidden]
 * @returns {HTMLSpanElement}
 */
export function createStatusBadge({
  documentRef = globalThis.document,
  label = '',
  appearance = 'pill',
  className = '',
  hidden = false,
} = {}) {
  const badge = documentRef.createElement('span');
  badge.className = [
    'gev-status-badge',
    appearance === 'box' && 'gev-status-badge--box',
    appearance === 'plain' && 'gev-status-badge--plain',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  updateStatusBadge(badge, { label, hidden });
  return badge;
}

/** Paint controlled text/visibility without replacing nodes or redundant writes. */
export function updateStatusBadge(badge, { label, hidden = false }) {
  if (badge.textContent !== label) badge.textContent = label;
  if (badge.hidden !== hidden) badge.hidden = hidden;
}
