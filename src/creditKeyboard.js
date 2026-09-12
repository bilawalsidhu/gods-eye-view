/**
 * Adds the keyboard semantics omitted by Cesium's href-less attribution links.
 * Cesium retains ownership of showing and hiding its required credit lightbox.
 */
export function configureCreditKeyboardAccess(root = document) {
  const expand = root?.querySelector?.('#cesium-credits .cesium-credit-expand-link');
  const lightbox = root?.querySelector?.('.cesium-credit-lightbox');
  const close = lightbox?.querySelector?.('.cesium-credit-lightbox-close');
  if (!expand || !lightbox || !close) return false;
  const overlay = lightbox.parentElement;

  if (!lightbox.id) lightbox.id = 'cesium-credit-lightbox';
  expand.setAttribute('role', 'button');
  expand.setAttribute('tabindex', '0');
  expand.setAttribute('aria-haspopup', 'dialog');
  expand.setAttribute('aria-controls', lightbox.id);
  expand.setAttribute('aria-expanded', 'false');
  close.setAttribute('role', 'button');
  close.setAttribute('tabindex', '0');
  close.setAttribute('aria-label', 'Close data attribution');

  if (expand.dataset.gevKeyboardReady === 'true') return true;
  expand.dataset.gevKeyboardReady = 'true';

  const installKeyboardActivation = (control) => {
    let spacePressed = false;
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat) control.click();
        return;
      }
      if (event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) spacePressed = true;
    });
    control.addEventListener('keyup', (event) => {
      if (event.key !== ' ') return;
      event.preventDefault();
      if (!spacePressed) return;
      spacePressed = false;
      control.click();
    });
    // A long Space hold may hand control to push-to-talk and move focus away.
    // Cancelling the armed release prevents that eventual keyup from also
    // activating the attribution control.
    control.addEventListener('blur', () => { spacePressed = false; });
  };
  const closeAndRestoreFocus = () => {
    expand.setAttribute('aria-expanded', 'false');
    expand.focus();
  };
  installKeyboardActivation(expand);
  installKeyboardActivation(close);
  lightbox.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close.click();
  });
  expand.addEventListener('click', () => {
    expand.setAttribute('aria-expanded', 'true');
    close.focus();
  });
  close.addEventListener('click', closeAndRestoreFocus);
  overlay?.addEventListener?.('click', (event) => {
    if (!lightbox.contains(event.target)) closeAndRestoreFocus();
  });
  return true;
}
