/** Measure Cockpit panels against visible HUD and viewport obstacles. */
import {
  resolveCockpitUtilityAnchor,
  resolveCockpitUtilityLayout,
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
  // The published presence shows the cards on Vue's next flush, before this
  // frame runs, so it counts as visible already.
  const contextVisible =
    this.context && (this.presence?.context || !this.context.hidden);
  const signalVisible =
    this.signalStream && (this.presence?.active || !this.signalStream.hidden);
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
  // The Contact card and its toggle render the collapse from the presence.
  if (this.presence.contextCollapsed !== this.contextCollapsed) {
    this.presence.contextCollapsed = this.contextCollapsed;
    this.publishPresenceView();
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
  // The briefing card and its toggle render the collapse from the presence.
  if (this.presence.signalCollapsed !== this.signalCollapsed) {
    this.presence.signalCollapsed = this.signalCollapsed;
    this.publishPresenceView();
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
    return;
  }

  const desktopInset = Math.max(24, Math.min(58, window.innerWidth * 0.04));
  this.context.dataset.layoutMode = 'bottom-left';
  this.context.style.setProperty(
    '--cockpit-context-left',
    `${desktopInset.toFixed(1)}px`,
  );
}

export function syncSignalLayout() {
  if (!this.signalStream || this.signalStream.hidden) return;
  const utilityControls = document.getElementById('cockpit-utility-controls');
  if (window.matchMedia('(max-width: 760px)').matches) {
    this.signalStream.dataset.layoutMode = 'compact-top';
    // The compact strip shows only an expanded control.
    this.publishUtilityLayout(utilityLayoutView({ hideCollapsed: true }));
    this.signalStream.style.removeProperty('--cockpit-signal-right');
    return;
  }

  const desktopInset = Math.max(24, Math.min(58, window.innerWidth * 0.04));
  this.signalStream.dataset.layoutMode = 'bottom-right';
  this.signalStream.style.setProperty(
    '--cockpit-signal-right',
    `${desktopInset.toFixed(1)}px`,
  );
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
    // The REC readout and the briefing card bound the utility corridor.
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
      minTopFloor: COCKPIT_UTILITY_MIN_TOP_PX,
      minTopRatio: COCKPIT_UTILITY_MIN_TOP_RATIO,
    });
    const availableHeight = utilityAnchor.maxHeight;
    const utilityLayout =
      expandedControl && collapsedControl
        ? resolveCockpitUtilityLayout({
            availableHeight,
            expandedHeight,
            collapsedHeight,
          })
        : { primaryOnly: false, expandedMaxHeight: availableHeight };
    this.publishUtilityLayout(
      utilityLayoutView({
        top: `${utilityAnchor.top.toFixed(1)}px`,
        maxHeight: `${availableHeight.toFixed(2)}px`,
        expandedMaxHeight: `${utilityLayout.expandedMaxHeight.toFixed(2)}px`,
        primaryOnly: utilityLayout.primaryOnly,
        hideCollapsed: utilityLayout.primaryOnly,
      }),
    );
    // Focus leaves a control the strip is about to hide.
    if (
      utilityLayout.primaryOnly &&
      collapsedControl?.contains(document.activeElement)
    ) {
      expandedControl
        ?.querySelector('.cockpit-utility-glyph')
        ?.focus({ preventScroll: true });
    }
  }
}

/**
 * The utility strip's layout as CockpitView and CockpitUtilityControls
 * render it: its anchor and height limits on the HUD, and which controls fit.
 */
function utilityLayoutView({
  top = null,
  maxHeight = null,
  expandedMaxHeight = null,
  primaryOnly = false,
  hideCollapsed = false,
} = {}) {
  return { top, maxHeight, expandedMaxHeight, primaryOnly, hideCollapsed };
}
