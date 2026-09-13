/**
 * Accessible replacements for window.prompt / window.confirm in the scene
 * director (Batch 6). Native blocking dialogs freeze the render loop, are
 * unstyleable, and are exempt from the page's focus management — the <dialog>
 * element fixes all three: showModal() traps focus, Esc cancels, the
 * background goes inert, and focus returns to the invoker on close.
 *
 * Both helpers resolve (never throw) so callers can `await` them without
 * try/catch: promptDialog resolves the untrimmed input on confirm, or null on
 * cancel/Esc — window.prompt's empty-string and cancel both abort the
 * callers, so collapsing them is behavior-preserving. confirmDialog resolves
 * true only on the confirm button, matching window.confirm.
 */

const CONFIRM_SENTINEL = '__gev_confirm__';

/** Shared chrome: modal dialog with a labelled heading and a dialog-method form. */
function _buildDialog({ title, className }) {
  const dialog = document.createElement('dialog');
  dialog.className = className;
  const headingId = `${className}-title`;
  dialog.setAttribute('aria-labelledby', headingId);

  const heading = document.createElement('h2');
  heading.id = headingId;
  heading.className = 'gev-dialog-title';
  heading.textContent = title;

  const form = document.createElement('form');
  form.method = 'dialog';

  dialog.append(heading, form);
  return { dialog, form };
}

/** Cancel + confirm submit buttons. A dialog-method submit closes the
 *  <dialog> and sets returnValue from the submitter's value before the
 *  close event fires, so the close handler can tell the paths apart. */
function _buildActions(form, { cancelText, confirmText }) {
  const actions = document.createElement('div');
  actions.className = 'gev-dialog-actions';

  const cancel = document.createElement('button');
  cancel.type = 'submit';
  cancel.value = '';
  cancel.className = 'gev-dialog-btn gev-dialog-cancel';
  cancel.textContent = cancelText;

  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.value = CONFIRM_SENTINEL;
  confirm.className = 'gev-dialog-btn gev-dialog-confirm';
  confirm.textContent = confirmText;

  actions.append(cancel, confirm);
  form.append(actions);
  return { cancel, confirm };
}

/**
 * Modal text prompt. Resolves the entered string on confirm, or null on
 * cancel/Esc. The initial value is preselected, like window.prompt.
 *
 * @param {object} options
 * @param {string} options.title Heading text (also the dialog's accessible name).
 * @param {string} options.label Visible field label.
 * @param {string} [options.value] Initial input value.
 * @param {string} [options.confirmText]
 * @param {string} [options.cancelText]
 * @returns {Promise<string|null>}
 */
export function promptDialog({
  title,
  label,
  value = '',
  confirmText = 'OK',
  cancelText = 'Cancel',
}) {
  return new Promise((resolve) => {
    const { dialog, form } = _buildDialog({ title, className: 'gev-prompt-dialog' });

    const fieldLabel = document.createElement('label');
    fieldLabel.className = 'gev-dialog-label';
    fieldLabel.htmlFor = 'gev-prompt-input';
    fieldLabel.textContent = label;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'gev-prompt-input';
    input.className = 'gev-dialog-input';
    input.value = value;
    input.autocomplete = 'off';
    input.spellcheck = false;
    // showModal() moves focus to the first element carrying autofocus.
    input.setAttribute('autofocus', '');

    form.append(fieldLabel, input);
    const { confirm } = _buildActions(form, { cancelText, confirmText });
    // Enter in the input must CONFIRM. Left to implicit form submission it
    // would activate the FIRST submit button in tree order — the Cancel
    // button — silently inverting the gesture.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirm.click();
      }
    });
    document.body.append(dialog);

    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === CONFIRM_SENTINEL;
      dialog.remove();
      resolve(confirmed ? input.value : null);
    });

    dialog.showModal();
    input.select();
  });
}

/**
 * Modal confirmation. Resolves true only when the confirm button is
 * activated; Esc and the cancel button resolve false (window.confirm parity).
 *
 * @param {object} options
 * @param {string} options.title Heading text (also the dialog's accessible name).
 * @param {string} options.message Body text.
 * @param {string} [options.confirmText]
 * @param {string} [options.cancelText]
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title,
  message,
  confirmText = 'Delete',
  cancelText = 'Cancel',
}) {
  return new Promise((resolve) => {
    const { dialog, form } = _buildDialog({ title, className: 'gev-confirm-dialog' });

    const body = document.createElement('p');
    body.className = 'gev-dialog-message';
    body.textContent = message;

    form.append(body);
    _buildActions(form, { cancelText, confirmText });
    document.body.append(dialog);

    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === CONFIRM_SENTINEL;
      dialog.remove();
      resolve(confirmed);
    });

    dialog.showModal();
  });
}
