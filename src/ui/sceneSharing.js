import { t, tn } from '../i18n/index.js';
import { createActionButton } from './actionButton.js';

/** Small owned modal for scene authoring and import review; text never becomes markup. */
export function createSceneDialog(title, onClose) {
  const dialog = document.createElement('dialog');
  dialog.dataset.directorDialog = '';
  dialog.className = 'director-sharing-dialog';
  dialog.setAttribute('aria-label', title);
  Object.assign(dialog.style, {
    background: '#08141e',
    color: '#e3faff',
    border: '1px solid #397080',
    borderRadius: '6px',
    padding: '20px',
    width: 'min(720px,calc(100vw - 32px))',
    boxSizing: 'border-box',
    position: 'fixed',
    inset: '0',
    margin: 'auto',
    maxHeight: 'calc(100vh - 32px)',
    overflow: 'auto',
    font: '14px/1.5 sans-serif',
  });
  const heading = document.createElement('h2');
  heading.textContent = title;
  heading.style.marginBottom = '12px';
  dialog.append(heading);
  const body = document.createElement('div'),
    footer = document.createElement('div'),
    status = document.createElement('p');
  status.setAttribute('role', 'status');
  dialog.append(body, status, footer);
  const listeners = [];
  function listen(node, type, fn) {
    node.addEventListener(type, fn);
    listeners.push(() => node.removeEventListener(type, fn));
  }
  function text(value, parent = body) {
    const p = document.createElement('p');
    p.textContent = value;
    p.style.margin = '8px 0';
    parent.append(p);
    return p;
  }
  function button(label, fn, parent = footer) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      background: '#10242e',
      color: '#e3faff',
      border: '1px solid #397080',
      borderRadius: '3px',
      padding: '7px 11px',
      margin: '6px 6px 6px 0',
      cursor: 'pointer',
      font: 'inherit',
    });
    listen(b, 'click', fn);
    parent.append(b);
    return b;
  }
  function input(label, value, { type = 'text', multiline = false } = {}) {
    const wrapper = document.createElement('label');
    wrapper.style.display = 'block';
    wrapper.textContent = label;
    const node = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) node.type = type;
    node.value = value;
    node.setAttribute('aria-label', label);
    Object.assign(node.style, {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      padding: '7px',
      margin: '6px 0 14px',
      color: '#e3faff',
      background: '#10242e',
      border: '1px solid #397080',
      font: multiline ? '12px monospace' : 'inherit',
    });
    if (multiline) node.rows = 9;
    wrapper.append(node);
    if (type === 'file') fileChooser(wrapper, node);
    body.append(wrapper);
    return node;
  }
  /**
   * The browser draws a file input's button and "no file" text in its own
   * language. Stretch the native input, transparent, over the whole row (so
   * click, focus and drops stay native) and draw translated text under it.
   */
  function fileChooser(wrapper, node) {
    wrapper.style.position = 'relative';
    Object.assign(node.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      margin: '0',
      padding: '0',
      border: '0',
      opacity: '0',
      cursor: 'pointer',
      zIndex: '1',
    });
    const row = document.createElement('span');
    row.setAttribute('aria-hidden', 'true');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      margin: '6px 0 14px',
      padding: '7px',
      background: '#10242e',
      border: '1px solid #397080',
    });
    const chooser = document.createElement('span');
    chooser.textContent = t('Choose files');
    Object.assign(chooser.style, {
      padding: '3px 9px',
      border: '1px solid #397080',
      borderRadius: '3px',
      background: '#08141e',
      cursor: 'pointer',
    });
    const chosen = document.createElement('span');
    const showChosen = () => {
      const count = node.files?.length || 0;
      // One file shows its name, like the browser's own picker did.
      chosen.textContent =
        count === 1
          ? node.files[0].name
          : count
            ? tn(count, '{count} file selected', '{count} files selected')
            : t('No file chosen');
    };
    showChosen();
    row.append(chooser, chosen);
    wrapper.append(row);
    listen(node, 'change', showChosen);
    listen(node, 'focus', () => {
      chooser.style.outline = '2px solid #e3faff';
    });
    listen(node, 'blur', () => {
      chooser.style.outline = '';
    });
  }
  button(t('Cancel'), onClose);
  listen(dialog, 'cancel', (event) => {
    event.preventDefault();
    onClose();
  });
  document.body.append(dialog);
  dialog.showModal();
  return {
    body,
    footer,
    status,
    text,
    button,
    input,
    listen,
    element: dialog,
    dispose() {
      for (const remove of listeners.splice(0)) remove();
      dialog.close();
      dialog.remove();
    },
  };
}

/** Add controls only when their owner is present; dispose removes every listener and element. */
export function mountSceneSharing(
  { edit, share },
  panel = document.getElementById('scene-panel'),
) {
  if (!panel) return () => {};
  const bar = document.createElement('div');
  bar.dataset.directorAuthoring = '';
  bar.className = 'scene-controls';
  const entries = [
    [t('EDIT DETAILS'), edit],
    [t('SHARE SCENE'), share],
  ];
  const removers = [];
  for (const [text, fn] of entries) {
    const b = createActionButton({ label: text, className: 'scene-btn' });
    b.addEventListener('click', fn);
    removers.push(() => b.removeEventListener('click', fn));
    bar.append(b);
  }
  (panel.querySelector?.('.scene-panel-inner') || panel).appendChild(bar);
  return () => {
    for (const remove of removers) remove();
    bar.remove();
  };
}
