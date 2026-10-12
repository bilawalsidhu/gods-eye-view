export const MOBILE_MENU_QUERY =
  '(pointer: coarse) and (max-width: 900px), (pointer: coarse) and (max-height: 600px)';
import {
  STREET_LEVEL_REVEAL_EVENT,
  STREET_LEVEL_MAP_PICK_EVENT,
} from './streetLevelControls.js';

/** One camera surface; minimizing never changes playback or desktop disclosure. */
export class MobileCameraVisibility {
  constructor() {
    this.activeId = null;
    this.minimized = true;
    this.initialized = false;
  }
  update(id) {
    if (this.activeId && !id) this.minimized = true;
    this.activeId = id || null;
    this.initialized = true;
  }
  show() {
    this.minimized = false;
  }
  minimize() {
    this.minimized = true;
  }
  get visible() {
    return !this.minimized;
  }
}

/** Reuse existing controls on phones and restore their exact DOM slots on desktop. */
export class MobileMenu {
  constructor({ shell, documentRef = document, windowRef = window }) {
    this.shell = shell;
    this.doc = documentRef;
    this.win = windowRef;
    this.moves = [];
    this.removers = [];
    this.camera = new MobileCameraVisibility();
    this.media = windowRef.matchMedia(MOBILE_MENU_QUERY);
    this.toolbar = documentRef.createElement('nav');
    this.toolbar.id = 'mobile-map-toolbar';
    this.toolbar.hidden = true;
    this.toolbar.setAttribute('aria-label', 'Mobile map controls');
    this.toolbar.innerHTML =
      '<button id="mobile-menu-open" type="button" aria-haspopup="dialog" aria-controls="mobile-map-menu" aria-expanded="false">MENU</button><button id="mobile-voice-open" type="button" aria-label="Toggle voice control" aria-pressed="false">MIC</button><button id="mobile-camera-return" type="button" hidden aria-label="Return to camera viewer">CAMERA</button>';
    this.locateButton = documentRef.getElementById('locate-me-btn');
    this.dialog = documentRef.createElement('dialog');
    this.dialog.id = 'mobile-map-menu';
    this.dialog.setAttribute('aria-labelledby', 'mobile-menu-title');
    this.dialog.innerHTML =
      '<header class="mobile-menu-header"><h2 id="mobile-menu-title">Map menu</h2><button id="mobile-menu-close" type="button" aria-label="Close menu and return to map">BACK TO MAP</button></header><div class="mobile-menu-sections"></div>';
    this.sections = new Map();
    for (const [id, title] of [
      ['places', 'Places'],
      ['layers', 'Data layers'],
      ['view', 'View & style'],
      ['cameras', 'Cameras'],
      ['scenes', 'Scenes'],
      ['settings', 'Display & settings'],
      ['voice', 'Voice'],
      ['details', 'Active details'],
    ]) {
      const details = documentRef.createElement('details');
      details.dataset.mobileSection = id;
      const summary = documentRef.createElement('summary');
      summary.textContent = title;
      const content = documentRef.createElement('div');
      content.className = 'mobile-menu-section-body';
      details.append(summary, content);
      this.dialog.querySelector('.mobile-menu-sections').append(details);
      this.sections.set(id, { details, content });
      this.listen(details, 'toggle', () => {
        if (details.open)
          for (const s of this.sections.values())
            if (s.details !== details) s.details.open = false;
      });
    }
    this.sections.get('cameras').content.innerHTML =
      '<button id="mobile-camera-open" type="button">OPEN CAMERA VIEWER</button><p>Select a camera in the viewer. Minimize keeps it available; Close stops the stream.</p>';
    this.sections.get('settings').content.innerHTML =
      '<label class="mobile-readouts-option"><input id="mobile-map-readouts" type="checkbox"> Show map readouts</label>';
    documentRef.body.append(this.toolbar, this.dialog);
    this.creditSlot = documentRef.createElement('footer');
    this.creditSlot.className = 'mobile-menu-credit-slot';
    this.dialog.append(this.creditSlot);
    this.opener = documentRef.getElementById('mobile-menu-open');
    this.returnCamera = documentRef.getElementById('mobile-camera-return');
    this.voiceButton = documentRef.getElementById('mobile-voice-open');
    this.minimizeButton = documentRef.createElement('button');
    this.minimizeButton.id = 'mobile-camera-minimize';
    this.minimizeButton.type = 'button';
    this.minimizeButton.textContent = 'MINIMIZE';
    this.minimizeButton.setAttribute(
      'aria-label',
      'Minimize camera and return to map',
    );
    documentRef
      .querySelector('#cctv-panel .panel-header')
      ?.insertBefore(
        this.minimizeButton,
        documentRef.getElementById('cctv-close-btn'),
      );
    this.fullscreenButton = documentRef.createElement('button');
    this.fullscreenButton.id = 'mobile-camera-fullscreen';
    this.fullscreenButton.className = 'scene-btn';
    this.fullscreenButton.type = 'button';
    this.fullscreenButton.textContent = 'FULLSCREEN';
    this.fullscreenButton.setAttribute('aria-label', 'View camera fullscreen');
    this.fullscreenButton.setAttribute('aria-expanded', 'false');
    this.fullscreenButton.setAttribute(
      'aria-controls',
      'mobile-camera-expanded',
    );
    this.minimizeButton.before(this.fullscreenButton);
    this.expandButton = documentRef.createElement('button');
    this.expandButton.id = 'desktop-camera-expand';
    this.expandButton.className = 'scene-btn';
    this.expandButton.type = 'button';
    this.expandButton.textContent = 'EXPAND';
    this.expandButton.title = 'Expand camera to fill the page';
    this.expandButton.setAttribute(
      'aria-label',
      'Expand camera to fill the page',
    );
    this.expandButton.setAttribute('aria-expanded', 'false');
    this.expandButton.setAttribute('aria-controls', 'mobile-camera-expanded');
    this.fullscreenButton.before(this.expandButton);
    this.expandedDialog = documentRef.createElement('dialog');
    this.expandedDialog.id = 'mobile-camera-expanded';
    this.expandedDialog.setAttribute('aria-label', 'Fullscreen camera viewer');
    this.expandedSurface = documentRef.createElement('div');
    this.expandedSurface.className = 'mobile-camera-expanded-surface';
    this.expandedFooter = documentRef.createElement('footer');
    this.expandedFooter.className = 'mobile-camera-expanded-credits';
    this.expandedSurface.append(this.expandedFooter);
    this.expandedDialog.append(this.expandedSurface);
    documentRef.body.append(this.expandedDialog);
    this.listen(this.fullscreenButton, 'click', () => {
      if (this.expandedDialog.open) this.exitCameraFullscreen();
      else this.enterCameraFullscreen();
    });
    this.listen(this.expandButton, 'click', () => {
      if (this.expandedMode === 'desktop') this.exitCameraFullscreen();
      else this.enterCameraFullscreen({ pageOnly: true });
    });
    this.listen(
      this.expandedDialog,
      'keydown',
      (event) => {
        if (this.expandedMode === 'desktop' && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.exitCameraFullscreen();
        }
      },
      true,
    );
    this.listen(this.expandedDialog, 'cancel', (event) => {
      event.preventDefault();
      this.exitCameraFullscreen();
    });
    this.listen(this.expandedDialog, 'close', () => {
      // A queued close from a fast Restore/Expand must not close the new view.
      if (!this.expandedDialog.open) this.exitCameraFullscreen();
    });
    this.listen(
      this.expandedDialog,
      'click',
      (event) => {
        const link = event.target.closest?.('.cesium-credit-expand-link');
        if (!link) return;
        event.preventDefault();
        event.stopPropagation();
        // The body-mounted credit dialog must wait for native fullscreen exit.
        Promise.resolve(this.exitCameraFullscreen({ focus: false })).then(
          () => {
            if (!this.destroyed && link.isConnected) link.click();
          },
        );
      },
      true,
    );
    this.listen(documentRef, 'fullscreenchange', () => {
      if (documentRef.fullscreenElement === this.expandedSurface) {
        // A pending browser request may finish after Close or a mode change.
        if (
          !this.expandedDialog.open ||
          this.requestEpoch !== this.expandedEpoch
        )
          this.exitNativeFullscreen();
        else this.hadNativeFullscreen = true;
      } else if (this.hadNativeFullscreen) {
        this.hadNativeFullscreen = false;
        this.exitCameraFullscreen();
      }
    });
    this.listen(this.opener, 'click', () => this.open());
    this.listen(documentRef.getElementById('mobile-menu-close'), 'click', () =>
      this.close(),
    );
    this.listen(this.dialog, 'cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.listen(this.dialog, 'close', () => {
      this.restoreCredits();
      this.doc.body.classList.remove('mobile-menu-open');
      this.opener.setAttribute('aria-expanded', 'false');
      this.syncCamera();
    });
    // Release native modal inertness before Cesium opens its own credit dialog.
    this.listen(
      this.dialog,
      'click',
      (event) => {
        if (event.target.closest?.('.cesium-credit-expand-link')) this.close();
      },
      true,
    );
    this.listen(this.dialog, 'click', (event) => {
      if (event.target === this.dialog) {
        const r = this.dialog.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          this.close();
      }
      const choice = event.target.closest?.(
        '.style-btn, .poi-pill, #tilt-map-view, #north-up-view, #reset-globe-view, #scene-start-btn, .map-stack-chip[data-stack-id]',
      );
      if (
        choice &&
        !choice.disabled &&
        choice.getAttribute('aria-disabled') !== 'true'
      )
        queueMicrotask(() => this.close());
    });
    this.listen(this.dialog, 'keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    // Capture intent before the existing lookup handler clears the field.
    this.listen(
      this.dialog,
      'keydown',
      (event) => {
        if (
          event.key === 'Enter' &&
          event.target.id === 'location-search' &&
          event.target.value.trim()
        ) {
          // The existing lookup listener still receives Enter. Cancel native
          // activation so returning focus to MENU cannot immediately reopen it.
          event.preventDefault();
          queueMicrotask(() => this.close());
        }
      },
      true,
    );
    this.listen(this.voiceButton, 'click', () =>
      this.doc.getElementById('gev-voice-button')?.click(),
    );
    this.listen(this.returnCamera, 'click', () => {
      this.close();
      this.camera.show();
      this.syncCamera();
      void shell._toggleCctvEnabled(true);
    });
    this.listen(windowRef, CCTV_FOCUS_REQUEST_EVENT, () => {
      if (this.mobile) {
        this.camera.show();
        this.syncCamera();
      }
    });
    this.listen(documentRef, STREET_LEVEL_REVEAL_EVENT, () =>
      this.revealStreetLevel(),
    );
    this.listen(documentRef, STREET_LEVEL_MAP_PICK_EVENT, () => {
      if (this.mobile) this.close();
    });
    this.listen(this.minimizeButton, 'click', () => {
      const exiting = this.exitCameraFullscreen({ focus: false });
      this.camera.minimize();
      this.syncCamera();
      this.returnCamera.focus({ preventScroll: true });
      Promise.resolve(exiting).then(() => {
        if (
          this.mobile &&
          !this.destroyed &&
          !this.camera.visible &&
          this.camera.activeId
        )
          this.returnCamera.focus({ preventScroll: true });
      });
    });
    this.listen(documentRef.getElementById('cctv-close-btn'), 'click', () => {
      const exiting = this.exitCameraFullscreen({ focus: false });
      this.camera.minimize();
      this.syncCamera();
      Promise.resolve(exiting).then(() => {
        if (this.mobile && !this.destroyed && !this.camera.visible)
          this.opener.focus({ preventScroll: true });
      });
    });
    this.listen(
      documentRef.getElementById('mobile-camera-open'),
      'click',
      () => {
        this.close();
        this.camera.show();
        this.syncCamera();
        void shell._toggleCctvEnabled(true);
      },
    );
    this.listen(
      documentRef.getElementById('mobile-map-readouts'),
      'change',
      (event) => {
        documentRef.body.classList.toggle(
          'mobile-show-readouts',
          event.target.checked,
        );
        if (
          event.target.checked &&
          !documentRef.getElementById('intel-hud')?.classList.contains('active')
        )
          documentRef.getElementById('hud-toggle')?.click();
      },
    );
    this.onMedia = () => this.syncMode();
    this.media.addEventListener('change', this.onMedia);
    this.unsubCamera = shell.services.cctvLayer?.subscribe?.((state) => {
      this.cameraEnabled = state?.enabled !== false;
      this.camera.update(state?.activeCameraId);
      this.syncCamera();
    });
    this.camera.update(
      shell.services.cctvLayer?.getUIState?.()?.activeCameraId,
    );
    this.cameraEnabled =
      shell.services.cctvLayer?.getUIState?.()?.enabled !== false;
    // Voice and some layer detail controls are mounted after the shell.
    this.observer = new MutationObserver(() => {
      if (this.frame || this.destroyed) return;
      this.frame = windowRef.requestAnimationFrame(() => {
        this.frame = null;
        if (this.mobile) this.moveLateControls();
        this.syncVoice();
      });
    });
    this.observer.observe(documentRef.body, { childList: true, subtree: true });
    this.syncMode();
  }
  listen(target, type, callback, options) {
    target?.addEventListener(type, callback, options);
    this.removers.push(() =>
      target?.removeEventListener(type, callback, options),
    );
  }
  move(node, section) {
    if (!node || this.moves.some((m) => m.node === node)) return;
    const marker = this.doc.createComment('mobile control original slot');
    node.before(marker);
    const ariaHidden = node.getAttribute('aria-hidden');
    node.removeAttribute('aria-hidden');
    const role = node.getAttribute('role');
    if (node.id === 'first-run-launcher') node.setAttribute('role', 'group');
    this.moves.push({ node, marker, ariaHidden, role });
    this.sections.get(section).content.append(node);
  }
  moveLateControls() {
    this.move(this.doc.getElementById('gev-voice-control'), 'voice');
    this.move(this.doc.getElementById('first-run-launcher'), 'places');
    this.move(this.doc.getElementById('key-setup-chip'), 'settings');
    for (const panel of this.doc.querySelectorAll(
      '#right-context-rail > [data-panel-id]:not(#cctv-panel):not(#pp-toggles)',
    ))
      this.move(panel, 'details');
  }
  syncMode() {
    const mobile = this.media.matches;
    if (mobile === this.mobile) return;
    this.exitCameraFullscreen({ focus: false });
    this.mobile = mobile;
    this.doc.body.classList.toggle('mobile-map-first', mobile);
    this.toolbar.hidden = !mobile;
    if (mobile) {
      // Restoration and automatic nearest-camera selection must not cover the map.
      this.camera.minimize();
      if (this.locateButton && !this.locateMarker) {
        this.locateMarker = this.doc.createComment(
          'locate button original slot',
        );
        this.locateButton.before(this.locateMarker);
        this.toolbar.insertBefore(this.locateButton, this.returnCamera);
      }
      for (const [selector, section] of [
        ['#location-bar-popover', 'places'],
        ['#data-toggles', 'layers'],
        ['#control-panel-popover', 'view'],
        ['#top-center-actions', 'view'],
        ['#scene-panel', 'scenes'],
        ['#pp-toggles', 'settings'],
      ])
        this.move(this.doc.querySelector(selector), section);
      const body = this.doc.querySelector('#cctv-panel .cyber-panel-body');
      for (const child of [...(body?.children || [])])
        if (
          child.id !== 'cctv-frame-wrap' &&
          child.id !== 'cctv-retry-status' &&
          !child.querySelector('#cctv-camera-select')
        )
          this.move(child, 'cameras');
      this.moveLateControls();
      this.syncCamera();
      this.syncVoice();
    } else {
      this.close();
      this.restoreControls();
      this.restoreLocateButton();
      this.moves = [];
      this.doc.body.classList.remove(
        'mobile-camera-open',
        'mobile-show-readouts',
      );
      this.doc.getElementById('mobile-map-readouts').checked = false;
      this.shell._scheduleLeftPanelLayout?.();
      this.shell._scheduleRightPanelLayout?.();
    }
  }
  syncVoice() {
    const button = this.doc.getElementById('gev-voice-button');
    if (button && button !== this.observedVoice) {
      this.voiceObserver?.disconnect();
      this.observedVoice = button;
      this.voiceObserver = new MutationObserver(() => this.syncVoice());
      this.voiceObserver.observe(button, {
        attributes: true,
        attributeFilter: ['aria-pressed', 'disabled'],
      });
    }
    this.voiceButton.disabled = !button || button.disabled;
    const active = button?.getAttribute('aria-pressed') === 'true';
    this.voiceButton.setAttribute('aria-pressed', String(active));
    const label = active ? 'MIC ON' : 'MIC';
    if (this.voiceButton.textContent !== label)
      this.voiceButton.textContent = label;
  }
  restoreLocateButton() {
    if (this.locateMarker?.parentNode)
      this.locateMarker.replaceWith(this.locateButton);
    this.locateMarker = null;
  }
  restoreControls() {
    for (const { node, marker, ariaHidden, role } of this.moves.reverse())
      if (marker.parentNode) {
        if (node.id === 'first-run-launcher') {
          if (role === null) node.removeAttribute('role');
          else node.setAttribute('role', role);
        }
        if (ariaHidden === null) node.removeAttribute('aria-hidden');
        else node.setAttribute('aria-hidden', ariaHidden);
        if (node.isConnected) marker.replaceWith(node);
        else marker.remove();
      }
  }
  syncCamera() {
    this.returnCamera.hidden = !this.camera.activeId;
    this.expandButton.disabled =
      !this.camera.activeId || this.cameraEnabled === false;
    this.doc.body.classList.toggle(
      'mobile-camera-open',
      !!this.mobile && this.camera.visible && !this.dialog.open,
    );
    if (
      this.expandedMode === 'desktop'
        ? this.mobile || !this.camera.activeId || this.cameraEnabled === false
        : !this.mobile || !this.camera.visible || this.dialog.open
    )
      this.exitCameraFullscreen({ focus: false });
  }
  enterCameraFullscreen({ pageOnly = false } = {}) {
    if (
      (pageOnly
        ? this.mobile || !this.camera.activeId || this.cameraEnabled === false
        : !this.mobile || !this.camera.visible) ||
      this.expandedDialog.open ||
      this.destroyed
    )
      return;
    const panel = this.doc.getElementById('cctv-panel');
    if (!panel) return;
    const origin = pageOnly ? panel.getBoundingClientRect() : null;
    this.expandedMode = pageOnly ? 'desktop' : 'mobile';
    this.expandedDialog.classList.toggle('desktop-camera-expanded', pageOnly);
    this.expandedDialog.setAttribute(
      'aria-label',
      pageOnly ? 'Expanded camera viewer' : 'Fullscreen camera viewer',
    );
    this.expandedMoves = [];
    for (const node of [
      panel,
      this.doc.getElementById('cctv-source-badge'),
      this.doc.getElementById('cctv-retry-status'),
      this.doc.getElementById('cesium-credits'),
    ]) {
      if (!node) continue;
      const marker = this.doc.createComment('expanded camera original slot');
      node.before(marker);
      this.expandedMoves.push({ node, marker });
      if (node === panel) this.expandedSurface.prepend(node);
      else this.expandedFooter.append(node);
    }
    this.fullscreenButton.textContent = 'BACK';
    this.fullscreenButton.setAttribute(
      'aria-label',
      'Exit fullscreen and return to camera preview',
    );
    this.fullscreenButton.setAttribute('aria-expanded', 'true');
    this.expandedDialog.showModal();
    this.expandButton.textContent = 'RESTORE';
    this.expandButton.title = 'Restore camera to its panel (Escape)';
    this.expandButton.setAttribute('aria-label', 'Restore camera to its panel');
    this.expandButton.setAttribute('aria-expanded', 'true');
    this.refreshCameraSurface();
    (pageOnly ? this.expandButton : this.fullscreenButton).focus({
      preventScroll: true,
    });
    const epoch = (this.expandedEpoch = (this.expandedEpoch || 0) + 1);
    if (pageOnly) {
      this.animateDesktopExpansion(origin);
      return; // Desktop is a webpage modal; never request browser fullscreen.
    }
    // The wrapper is eligible for fullscreen; a dialog itself is not.
    // Invoke synchronously during the button gesture. Rejection keeps the modal.
    if (
      this.doc.fullscreenEnabled &&
      this.expandedSurface.requestFullscreen &&
      !this.pendingFullscreen
    ) {
      try {
        this.requestEpoch = epoch;
        const pending = Promise.resolve(
          this.expandedSurface.requestFullscreen({ navigationUI: 'hide' }),
        )
          .then(() => {
            if (!this.expandedDialog.open || epoch !== this.expandedEpoch)
              return this.exitNativeFullscreen();
          })
          .catch(() => {})
          .finally(() => {
            if (this.pendingFullscreen === pending)
              this.pendingFullscreen = null;
          });
        this.pendingFullscreen = pending;
      } catch {
        /* The viewport-filling modal is already usable. */
      }
    }
  }
  animateDesktopExpansion(origin) {
    this.expansionAnimation?.cancel();
    this.expansionAnimation = null;
    if (
      this.win.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !this.expandedSurface.animate
    )
      return;
    const destination = this.expandedSurface.getBoundingClientRect();
    if (
      !origin?.width ||
      !origin.height ||
      !destination.width ||
      !destination.height
    )
      return;
    const scale = Math.min(
      origin.width / destination.width,
      origin.height / destination.height,
      1,
    );
    const x =
      origin.x + origin.width / 2 - (destination.x + destination.width / 2);
    const y =
      origin.y + origin.height / 2 - (destination.y + destination.height / 2);
    // Uniform scaling keeps the live video aspect ratio throughout the zoom.
    this.expansionAnimation = this.expandedSurface.animate(
      [
        {
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
          opacity: 0.75,
        },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }
  exitNativeFullscreen() {
    if (this.doc.fullscreenElement !== this.expandedSurface) return;
    try {
      return Promise.resolve(this.doc.exitFullscreen()).catch(() => {});
    } catch {
      /* Browser/system exit remains available. */
    }
  }
  exitCameraFullscreen({ focus = true } = {}) {
    this.expansionAnimation?.cancel();
    this.expansionAnimation = null;
    const exiting = this.exitNativeFullscreen();
    if (!this.expandedMoves?.length) return exiting;
    const desktop = this.expandedMode === 'desktop';
    this.expandedMode = null;
    this.expandedEpoch = (this.expandedEpoch || 0) + 1;
    const epoch = this.expandedEpoch;
    this.hadNativeFullscreen = false;
    const moves = this.expandedMoves;
    this.expandedMoves = [];
    if (this.expandedDialog.open) this.expandedDialog.close();
    for (const { node, marker } of moves.reverse())
      if (marker.parentNode) {
        if (node.isConnected) marker.replaceWith(node);
        else marker.remove();
      }
    this.fullscreenButton.textContent = 'FULLSCREEN';
    this.fullscreenButton.setAttribute('aria-label', 'View camera fullscreen');
    this.fullscreenButton.setAttribute('aria-expanded', 'false');
    this.expandButton.textContent = 'EXPAND';
    this.expandButton.title = 'Expand camera to fill the page';
    this.expandButton.setAttribute(
      'aria-label',
      'Expand camera to fill the page',
    );
    this.expandButton.setAttribute('aria-expanded', 'false');
    this.expandedDialog.classList.remove('desktop-camera-expanded');
    this.refreshCameraSurface();
    const returnFocus = () => {
      if (
        focus &&
        epoch === this.expandedEpoch &&
        (desktop
          ? !this.mobile && !!this.camera.activeId
          : this.mobile && this.camera.visible) &&
        !this.dialog.open &&
        !this.destroyed &&
        (this.doc.activeElement === this.doc.body ||
          this.doc.activeElement === this.fullscreenButton ||
          this.doc.activeElement === this.expandButton)
      )
        (desktop ? this.expandButton : this.fullscreenButton).focus({
          preventScroll: true,
        });
    };
    returnFocus();
    return Promise.all([exiting, this.pendingFullscreen])
      .then(() => {
        if (epoch === this.expandedEpoch) return this.exitNativeFullscreen();
      })
      .then(() => {
        returnFocus();
      });
  }
  /** Reveal a Street action's actual mobile accordion, not only its panel. */
  revealStreetLevel() {
    if (!this.mobile || this.destroyed) return;
    this.moveLateControls();
    for (const [id, section] of this.sections)
      section.details.open = id === 'details';
    this.open();
    this.win.requestAnimationFrame(() => {
      if (!this.mobile || this.destroyed || !this.dialog.open) return;
      this.doc
        .getElementById('street-level-panel')
        ?.scrollIntoView?.({ block: 'nearest' });
      this.shell._streetLevelControls?.onPanelResized?.();
    });
  }
  open() {
    if (!this.mobile || this.dialog.open) return;
    this.doc.body.classList.add('mobile-menu-open');
    const credit = this.doc.getElementById('cesium-credits');
    if (credit) {
      this.creditMarker = this.doc.createComment('mobile menu credit slot');
      credit.before(this.creditMarker);
      this.creditSlot.append(credit);
    }
    this.opener.setAttribute('aria-expanded', 'true');
    this.dialog.showModal();
    this.syncCamera();
    this.doc.getElementById('mobile-menu-close').focus({ preventScroll: true });
  }
  refreshCameraSurface() {
    const controls = this.shell._cctvControls;
    controls?._renderCctvState?.(controls.getState());
  }
  close() {
    if (this.dialog.open) this.dialog.close();
    this.restoreCredits();
    this.doc.body.classList.remove('mobile-menu-open');
    this.opener.setAttribute('aria-expanded', 'false');
    this.syncCamera();
    if (this.mobile) this.opener.focus({ preventScroll: true });
  }
  restoreCredits() {
    if (this.creditMarker?.parentNode)
      this.creditMarker.replaceWith(this.doc.getElementById('cesium-credits'));
    this.creditMarker = null;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.exitCameraFullscreen({ focus: false });
    this.close();
    this.observer.disconnect();
    this.voiceObserver?.disconnect();
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.unsubCamera?.();
    this.media.removeEventListener('change', this.onMedia);
    for (const remove of this.removers) remove();
    this.restoreControls();
    this.restoreLocateButton();
    this.doc.body.classList.remove(
      'mobile-map-first',
      'mobile-camera-open',
      'mobile-menu-open',
      'mobile-show-readouts',
    );
    this.minimizeButton.remove();
    this.fullscreenButton.remove();
    this.expandButton.remove();
    this.expandedDialog.remove();
    this.toolbar.remove();
    this.dialog.remove();
  }
}
import { CCTV_FOCUS_REQUEST_EVENT } from '../cctvFocusRequest.js';
