import PanelRailView from './PanelRailView.vue';
import { PANEL_RAIL_HOST_CLASS, PANEL_RAIL_ITEMS } from './panelRailCatalog.js';
import { usePanelStore } from './stores/panels.js';

/**
 * Own the desktop panel rails: publish each side's panels to the panel store
 * and open or close a panel when its rail item is selected. Disclosure itself
 * stays with PanelChrome, which enforces one open panel per side.
 */
export class PanelNavigation {
  /**
   * @param {object} options
   * @param {{pinia: object, mount: Function}} options.ui Shell Vue runtime.
   * @param {{left: HTMLElement|null, right: HTMLElement|null}} options.stacks Side panel stacks.
   * @param {Function} options.setPanelCollapsed PanelChrome's disclosure operation.
   */
  constructor({ ui, stacks, setPanelCollapsed }) {
    this._ui = ui;
    this._stacks = stacks;
    this._setPanelCollapsed = setPanelCollapsed;
    this._store = usePanelStore(ui.pinia);
    this._unmounts = [];
    this._hosts = [];
    this._observer = null;
    this._destroyed = false;
    this._onOutsidePointer = (event) => {
      if (
        document.documentElement.dataset.uiTheme !== 'minimal' ||
        document.body.classList.contains('mobile-shell') ||
        document.body.classList.contains('cockpit-mode')
      )
        return;
      if (
        event.target.closest?.(
          '.gev-panel-rail, [data-panel-id], #command-dock, #world-timeline, #corner-actions, #key-setup',
        )
      )
        return;
      if (!event.target.closest?.('#cesiumContainer, #world-overlay-root'))
        return;
      const surfaces = [
        ...Object.values(this._stacks)
          .filter(Boolean)
          .flatMap((stack) => [...stack.children])
          .filter((panel) => panel.matches('[data-panel-id]')),
        document.getElementById('location-bar'),
        document.getElementById('control-panel'),
      ];
      for (const panel of surfaces) {
        if (panel && !panel.hidden && !panel.classList.contains('collapsed'))
          this._setPanelCollapsed(panel.id, true, { explicit: true });
      }
    };
  }

  init() {
    if (this._destroyed) return;
    document.addEventListener('pointerdown', this._onOutsidePointer);
    for (const side of ['left', 'right']) {
      const stack = this._stacks[side];
      if (!stack) continue;
      // Inside the stack, the rail shows and hides with its panels in every
      // presentation mode (Cockpit, clean view, recording, phone sheets).
      const host = stack.ownerDocument.createElement('div');
      host.className = `${PANEL_RAIL_HOST_CLASS} ${PANEL_RAIL_HOST_CLASS}--${side}`;
      stack.prepend(host);
      this._hosts.push(host);
      this._unmounts.push(
        this._ui.mount(PanelRailView, host, {
          side,
          onSelect: (panelId) => this.select(panelId),
        }),
      );
    }
    if (typeof MutationObserver !== 'undefined') {
      // Only the panels themselves matter: their order, disclosure and
      // availability, not changes inside them or inside the rails.
      this._observer = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              record.target === document.documentElement ||
              record.target === document.body ||
              this._isPanelRecord(record),
          )
        )
          this.sync();
      });
      this._observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-ui-theme'],
      });
      this._observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
      });
      for (const stack of Object.values(this._stacks)) {
        if (!stack) continue;
        this._observer.observe(stack, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'hidden'],
        });
      }
    }
    this.sync();
  }

  /** Publish both sides' panels in display order. */
  sync() {
    if (this._destroyed) return;
    // A restored view or a skin switch may begin with two expanded sides.
    // Fold the extra surface for this presentation without rewriting saved
    // preferences. Normal user/feature opens are handled by PanelChrome.
    if (
      document.documentElement.dataset.uiTheme === 'minimal' &&
      !document.body.classList.contains('mobile-shell') &&
      !document.body.classList.contains('cockpit-mode')
    ) {
      const expanded = [this._stacks.right, this._stacks.left]
        .filter(Boolean)
        .flatMap((stack) => [...stack.children])
        .filter(
          (panel) =>
            panel.matches('[data-panel-id]') &&
            !panel.hidden &&
            !panel.classList.contains('collapsed'),
        );
      for (const panel of expanded.slice(1)) {
        this._setPanelCollapsed(panel.id, true, {
          restore: true,
          persist: false,
          syncShare: false,
        });
      }
    }
    for (const side of ['left', 'right']) {
      const stack = this._stacks[side];
      const panels = stack
        ? [...stack.children]
            .filter((panel) => panel.matches('[data-panel-id]'))
            .map((panel) => {
              const shownBy = PANEL_RAIL_ITEMS[panel.id]?.shownBy;
              return {
                id: panel.id,
                title:
                  panel
                    .querySelector('.panel-title, .pp-header-label')
                    ?.textContent.trim() || panel.id,
                open: !panel.classList.contains('collapsed'),
                available:
                  !panel.hidden &&
                  (!shownBy || panel.classList.contains(shownBy)),
              };
            })
        : [];
      this._store.setSide(side, panels);
    }
  }

  /**
   * Toggle a panel from its rail item.
   * @param {string} panelId Panel element id.
   */
  select(panelId) {
    if (this._destroyed) return;
    // The panel itself, not the store: the store follows its class a
    // microtask later, after a same-task setPanelCollapsed.
    const panel = document.getElementById(panelId);
    if (!panel) return;
    this._setPanelCollapsed(panelId, !panel.classList.contains('collapsed'), {
      explicit: true,
    });
  }

  _isPanelRecord(record) {
    const stacks = Object.values(this._stacks);
    return record.type === 'childList'
      ? stacks.includes(record.target) &&
          [...record.addedNodes, ...record.removedNodes].some(
            (node) => !this._hosts.includes(node),
          )
      : stacks.includes(record.target.parentElement);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    document.removeEventListener('pointerdown', this._onOutsidePointer);
    this._observer?.disconnect();
    this._observer = null;
    for (const unmount of this._unmounts) unmount();
    this._unmounts = [];
    for (const host of this._hosts) host.remove();
    this._hosts = [];
  }
}
