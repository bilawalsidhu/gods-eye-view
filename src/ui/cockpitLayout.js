/** Measure Cockpit panels against visible HUD and viewport obstacles. */
import {
  resolveCockpitUtilityAnchor,
  resolveCockpitUtilityLayout,
  resolveCyberCockpitPanelLane,
} from '../cockpitUtilityLayout.js';
import {
  COCKPIT_UTILITY_REC_GAP_PX,
  COCKPIT_UTILITY_SIGNAL_GAP_PX,
  COCKPIT_UTILITY_MIN_TOP_PX,
  COCKPIT_UTILITY_MIN_TOP_RATIO,
  COCKPIT_UTILITY_LAUNCHER_MIN_HEIGHT_PX,
  isRenderedOnScreen,
} from './cockpitPresentation.js';

export function scheduleContextLayout() {
  if (this.destroyed) return false;
  const contextVisible = this.context && !this.context.hidden;
  const signalVisible = this.signalStream && !this.signalStream.hidden;
  if ((!contextVisible && !signalVisible) || this.contextLayoutFrame !== null)
    return;
  this.contextLayoutFrame = requestAnimationFrame(() => {
    this.contextLayoutFrame = null;
    if (this.destroyed) return;
    this.syncContextLayout();
    this.syncSignalLayout();
  });
}

export function setContextCollapsed(collapsed) {
  const wasCollapsed = this.contextCollapsed;
  this.contextCollapsed = Boolean(collapsed);
  if (this.context)
    this.context.dataset.collapsed = String(this.contextCollapsed);
  if (this.contextToggle) {
    const expanded = !this.contextCollapsed;
    this.contextToggle.setAttribute('aria-expanded', String(expanded));
    this.contextToggle.setAttribute(
      'aria-label',
      `${expanded ? 'Collapse' : 'Expand'} Contact panel`,
    );
    this.contextToggle.title = `${expanded ? 'Collapse' : 'Expand'} contact panel`;
    const icon = this.contextToggle.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = expanded ? 'chevron_left' : 'chevron_right';
  }
  if (this.active && wasCollapsed && !this.contextCollapsed) {
    window.dispatchEvent(new CustomEvent('gev:cockpit-context-expanded'));
  }
  this.scheduleContextLayout();
}

export function setSignalCollapsed(collapsed, { user = false } = {}) {
  const wasCollapsed = this.signalCollapsed;
  this.signalCollapsed = Boolean(collapsed);
  if (user) this.signalUserCollapsed = this.signalCollapsed;
  if (this.signalStream)
    this.signalStream.dataset.collapsed = String(this.signalCollapsed);
  if (this.signalToggle) {
    const expanded = !this.signalCollapsed;
    this.signalToggle.setAttribute('aria-expanded', String(expanded));
    this.signalToggle.setAttribute(
      'aria-label',
      `${expanded ? 'Collapse' : 'Expand'} cockpit briefing panel`,
    );
    this.signalToggle.title = `${expanded ? 'Collapse' : 'Expand'} briefing panel`;
    const icon = this.signalToggle.querySelector('.material-symbols-outlined');
    if (icon)
      icon.textContent = expanded ? 'right_panel_close' : 'right_panel_open';
  }
  if (this.signalCollapsed) this.stopBriefRotation();
  else this.startBriefRotation({ reset: true });
  if (this.active && wasCollapsed && !this.signalCollapsed) {
    window.dispatchEvent(new CustomEvent('gev:cockpit-signal-expanded'));
  }
  this.scheduleContextLayout();
}

export function syncContextLayout() {
  if (!this.context || this.context.hidden) return;
  if (window.matchMedia('(max-width: 760px)').matches) {
    this.context.dataset.layoutMode = 'compact-bottom';
    this.context.style.removeProperty('--cockpit-context-left');
    this.context.style.removeProperty('--cockpit-context-top');
    this.context.style.removeProperty('--cockpit-context-max-height');
    return;
  }

  const desktopInset = Math.max(24, Math.min(58, window.innerWidth * 0.04));
  this.context.dataset.layoutMode = 'bottom-left';
  this.context.style.setProperty(
    '--cockpit-context-left',
    `${desktopInset.toFixed(1)}px`,
  );
  if (document.documentElement.dataset.uiTheme !== 'cyber') {
    this.context.style.removeProperty('--cockpit-context-top');
    this.context.style.removeProperty('--cockpit-context-max-height');
    return;
  }
  const defaultTop = Math.max(255, Math.min(300, window.innerHeight * 0.28));
  const dataPanel = document.querySelector(
    '#left-panel-stack > #data-panel:not(.collapsed)',
  );
  let desiredTop = defaultTop;
  if (this.contextCollapsed && dataPanel) {
    desiredTop = Math.max(
      desiredTop,
      dataPanel.getBoundingClientRect().bottom + 8,
    );
  }
  const contextBounds = this.context.getBoundingClientRect();
  let safeBottom = window.innerHeight - 24;
  for (const selector of [
    '#cesium-credits',
    '#command-dock',
    '#view-switcher',
  ]) {
    const obstacle = document.querySelector(selector);
    if (!obstacle) continue;
    const style = window.getComputedStyle(obstacle);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    )
      continue;
    const bounds = obstacle.getBoundingClientRect();
    const overlapsHorizontally =
      bounds.right > contextBounds.left && bounds.left < contextBounds.right;
    if (overlapsHorizontally && bounds.top > desiredTop) {
      safeBottom = Math.min(safeBottom, bounds.top - 8);
    }
  }
  const boundedTop = Math.max(
    defaultTop,
    Math.min(desiredTop, safeBottom - contextBounds.height),
  );
  this.context.style.setProperty(
    '--cockpit-context-top',
    `${boundedTop.toFixed(1)}px`,
  );
  this.context.style.removeProperty('--cockpit-context-max-height');
}

export function syncSignalLayout() {
  if (!this.signalStream || this.signalStream.hidden) return;
  const utilityControls = document.getElementById('cockpit-utility-controls');
  if (window.matchMedia('(max-width: 760px)').matches) {
    this.signalStream.dataset.layoutMode = 'compact-top';
    utilityControls?.classList.remove('layout-primary-only');
    utilityControls
      ?.querySelectorAll('.cockpit-utility-control')
      .forEach((control) => {
        const hiddenSibling = Boolean(
          utilityControls.querySelector(
            '.cockpit-utility-control.is-expanded',
          ) && !control.classList.contains('is-expanded'),
        );
        control.setAttribute('aria-hidden', String(hiddenSibling));
      });
    this.hud?.style.removeProperty('--cockpit-utility-top');
    this.hud?.style.removeProperty('--cockpit-utility-max-height');
    this.hud?.style.removeProperty('--cockpit-utility-expanded-max-height');
    this.signalStream.style.removeProperty('--cockpit-signal-right');
    this.signalStream.style.removeProperty('--cockpit-signal-top');
    this.signalStream.style.removeProperty('--cockpit-signal-max-height');
    return;
  }

  const desktopInset = Math.max(24, Math.min(58, window.innerWidth * 0.04));
  this.signalStream.dataset.layoutMode = 'bottom-right';
  this.signalStream.style.setProperty(
    '--cockpit-signal-right',
    `${desktopInset.toFixed(1)}px`,
  );
  this.signalStream.style.removeProperty('--cockpit-signal-top');
  this.signalStream.style.removeProperty('--cockpit-signal-max-height');
  const cyber = document.documentElement.dataset.uiTheme === 'cyber';
  const leftPanel = cyber
    ? document.querySelector('#left-panel-stack > #data-panel')
    : null;
  const alignedTop = isRenderedOnScreen(leftPanel)
    ? leftPanel.getBoundingClientRect().top
    : null;
  // Cyber's two rails share a top edge. Move the briefing below the collapsed
  // strip rather than pulling the right rail upward to avoid it.
  if (alignedTop !== null && utilityControls) {
    const expanded = utilityControls.querySelector(
      '.cockpit-utility-control.is-expanded',
    );
    if (!expanded) {
      const signalTop = Math.max(
        Math.max(255, Math.min(300, window.innerHeight * 0.28)),
        alignedTop + utilityControls.getBoundingClientRect().height + 28,
      );
      this.signalStream.style.setProperty(
        '--cockpit-signal-top',
        `${signalTop.toFixed(1)}px`,
      );
      this.signalStream.style.setProperty(
        '--cockpit-signal-max-height',
        `${Math.max(44, window.innerHeight - signalTop - 80).toFixed(1)}px`,
      );
    }
  }
  const signalBounds = this.signalStream.getBoundingClientRect();
  const utilityBounds = utilityControls?.getBoundingClientRect();
  if (utilityBounds) {
    const expandedControl = utilityControls?.querySelector(
      '.cockpit-utility-control.is-expanded',
    );
    const collapsedControl = utilityControls?.querySelector(
      '.cockpit-utility-control:not(.is-expanded)',
    );
    const collapsedLauncher = collapsedControl?.querySelector(
      '.cockpit-utility-launcher',
    );
    const expandedHeight = expandedControl
      ? Math.max(
          expandedControl.scrollHeight,
          expandedControl.getBoundingClientRect().height,
        )
      : 0;
    const collapsedHeight = collapsedLauncher
      ? Math.max(
          COCKPIT_UTILITY_LAUNCHER_MIN_HEIGHT_PX,
          collapsedLauncher.scrollHeight,
        )
      : 0;
    if (alignedTop !== null) {
      const lane = resolveCyberCockpitPanelLane({
        viewportHeight: window.innerHeight,
        top: alignedTop,
        launcherHeight: Math.max(
          collapsedHeight,
          collapsedLauncher?.getBoundingClientRect().height || 60,
        ),
        signalHeight: this.signalCollapsed ? signalBounds.height : 44,
        contactHeight:
          this.contextCollapsed && this.context
            ? this.context.getBoundingClientRect().height
            : 64,
      });
      document.body.style.setProperty(
        '--cyber-cockpit-panel-height',
        `${lane.panelHeight.toFixed(2)}px`,
      );
      this.hud?.style.setProperty(
        '--cockpit-utility-top',
        `${alignedTop.toFixed(2)}px`,
      );
      this.hud?.style.setProperty(
        '--cockpit-utility-max-height',
        `${lane.utilityHeight.toFixed(2)}px`,
      );
      this.hud?.style.setProperty(
        '--cockpit-utility-expanded-max-height',
        `${lane.panelHeight.toFixed(2)}px`,
      );
      utilityControls.classList.remove('layout-primary-only');
      utilityControls
        .querySelectorAll('.cockpit-utility-control')
        .forEach((control) => control.setAttribute('aria-hidden', 'false'));
      if (expandedControl) {
        this.signalStream.style.setProperty(
          '--cockpit-signal-top',
          `${lane.signalTop.toFixed(2)}px`,
        );
      }
      this.syncContextLayout();
      return;
    }
    // Non-Cyber themes retain their independent REC/briefing corridor. Cyber
    // uses the rendered Data Layers top after reserving briefing space above.
    // The readout only anchors the strip while it is genuinely on screen:
    // the Minimal variant drops it with `display:none`, but HUD Off hides the
    // whole Intel HUD with `visibility`/`opacity`, which keeps its rect.
    const recReadout = document.querySelector('#intel-hud .hud-top-right');
    const recBounds = isRenderedOnScreen(recReadout)
      ? recReadout.getBoundingClientRect()
      : null;
    const utilityAnchor = resolveCockpitUtilityAnchor({
      recBottom: recBounds ? recBounds.bottom : 0,
      signalTop: signalBounds.top,
      stripHeight: utilityBounds.height,
      viewportHeight: window.innerHeight,
      collapsedHeight,
      recGap: COCKPIT_UTILITY_REC_GAP_PX,
      signalGap: COCKPIT_UTILITY_SIGNAL_GAP_PX,
      minTopFloor: alignedTop ?? COCKPIT_UTILITY_MIN_TOP_PX,
      minTopRatio: alignedTop !== null ? 0 : COCKPIT_UTILITY_MIN_TOP_RATIO,
      signalCollapsed: this.signalCollapsed,
      utilityExpanded: Boolean(expandedControl),
      // Only Cyber relocates its collapsed briefing below the utility lane.
      // Other themes keep the measured visible card as the lower boundary.
      reserveViewportLane: document.documentElement.dataset.uiTheme === 'cyber',
      // Cyber keeps the collapsed briefing reachable below the utility instead
      // of hiding it. Reserve its actual height, including wrapped headings.
      signalHeight:
        document.documentElement.dataset.uiTheme === 'cyber' &&
        this.signalCollapsed
          ? signalBounds.height
          : 0,
    });
    const availableHeight = utilityAnchor.maxHeight;
    this.hud?.style.setProperty(
      '--cockpit-utility-top',
      `${utilityAnchor.top.toFixed(1)}px`,
    );
    this.hud?.style.setProperty(
      '--cockpit-utility-max-height',
      `${availableHeight.toFixed(2)}px`,
    );
    const utilityLayout =
      expandedControl && collapsedControl
        ? resolveCockpitUtilityLayout({
            availableHeight,
            expandedHeight,
            collapsedHeight,
          })
        : { primaryOnly: false, expandedMaxHeight: availableHeight };
    utilityControls?.classList.toggle(
      'layout-primary-only',
      utilityLayout.primaryOnly,
    );
    this.hud?.style.setProperty(
      '--cockpit-utility-expanded-max-height',
      `${utilityLayout.expandedMaxHeight.toFixed(2)}px`,
    );
    utilityControls
      ?.querySelectorAll('.cockpit-utility-control')
      .forEach((control) => {
        const hiddenSibling =
          utilityLayout.primaryOnly && control === collapsedControl;
        control.setAttribute('aria-hidden', String(hiddenSibling));
        if (hiddenSibling && control.contains(document.activeElement)) {
          expandedControl
            ?.querySelector('.cockpit-utility-glyph')
            ?.focus({ preventScroll: true });
        }
      });
  }
}
