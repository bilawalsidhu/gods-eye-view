/**
 * Create an ordinary native action button. Static templates use the same CSS
 * classes. Labels are already translated; feature owners retain callbacks,
 * disabled-state updates and listener cleanup. Construction binds no listeners.
 * @param {object} options
 * @param {Document} [options.documentRef] Document that owns the button.
 * @param {string} options.label Visible text, never interpreted as markup.
 * @param {string} [options.className] Additional feature/layout hooks.
 * @param {'default'|'danger'} [options.variant]
 * @param {'default'|'compact'} [options.size]
 * @param {boolean} [options.disabled]
 * @param {string} [options.ariaLabel] Accessible name when visible text needs context.
 * @param {string} [options.title]
 * @returns {HTMLButtonElement}
 */
export function createActionButton({
  documentRef = globalThis.document,
  label,
  className = '',
  variant = 'default',
  size = 'default',
  disabled = false,
  ariaLabel,
  title,
}) {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = [
    'gev-action-button',
    variant === 'danger' && 'gev-action-button--danger',
    size === 'compact' && 'gev-action-button--compact',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  button.textContent = label;
  button.disabled = disabled;
  if (ariaLabel !== undefined) button.setAttribute('aria-label', ariaLabel);
  if (title !== undefined) button.title = title;
  return button;
}
