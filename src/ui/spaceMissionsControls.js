import { useEntityCardStore } from './stores/entityCard.js';
import { useContextStore } from './stores/context.js';
import { applicationPinia } from './vueRuntime.js';

const LAYER_ID = 'rocket-launches';
// An explicit list command reveals after checking its own turn and Context ownership.
export const MISSION_LIST_REVEAL = Symbol('mission-list-reveal');

export function captureMissionReveal() {
  const pinia = applicationPinia();
  const cards = useEntityCardStore(pinia);
  const context = useContextStore(pinia);
  const generation = cards.selectionGeneration();
  const tab = context.inspectorTab;
  return () =>
    cards.selectionGeneration() === generation && context.inspectorTab === tab;
}

/**
 * The Space Missions layer's wiring. Space Missions is an ordinary layer: the
 * layer owns its data and Satellites dependency, and this connects it to its
 * list in Context's Inspect view. The list shows when a person turns the
 * layer on (by hand or by voice) or picks a mission on the globe.
 * This wiring switches no layer itself. The layer leaves the person's other
 * layers as they are, apart from Satellites, which it uses for orbit data
 * and restores when it turns off
 * (`src/layers/launches/ingestion.js`).
 */
export class SpaceMissionsControls {
  /**
   * @param {object} options
   * @param {?object} options.layer The Space Missions layer.
   * @param {object} options.store The Space Missions store.
   * @param {object} options.actions
   * @param {(options: {keepFollow: boolean}) => void} options.actions.showMissions Opens Context on the
   *   Missions list (and, on a phone, its sheet).
   * @param {() => boolean} options.actions.isCockpitActive
   */
  constructor({ layer, store, actions }) {
    this._layer = layer || null;
    this._store = store;
    this._actions = actions;
    this._manager = null;
    this._unsubscribeManager = null;
    this.destroyed = false;
    store.connect(this._layer);
    store.publish(null);
    store.setEnabled(false);
    this._unsubscribePanel =
      this._layer?.subscribePanel?.((view) => store.publish(view)) ?? null;
    this._unsubscribeGlobePick =
      this._layer?.subscribeGlobePick?.(() =>
        this._reveal({ keepFollow: false }),
      ) ?? null;
  }

  /** Follow a data manager's Space Missions visibility; null disconnects. */
  connect(manager) {
    this._unsubscribeManager?.();
    this._unsubscribeRequest?.();
    this._pendingReveal = null;
    this._unsubscribeManager = null;
    this._manager = manager || null;
    if (this.destroyed) return;
    this._syncEnabled();
    this._unsubscribeRequest = manager?.subscribeVisibilityRequests?.(
      (change) => {
        if (change.layerId !== LAYER_ID) return;
        this._pendingReveal =
          change.enabled &&
          change.notificationToken !== MISSION_LIST_REVEAL &&
          (change.origin === 'user' || change.origin === 'voice')
            ? { epoch: change.intentEpoch, current: captureMissionReveal() }
            : null;
      },
    );
    this._unsubscribeManager =
      this._manager?.subscribe?.((change) => this._handleChange(change)) ??
      null;
  }

  _syncEnabled() {
    this._store.setEnabled(Boolean(this._manager?.isEnabled?.(LAYER_ID)));
  }

  _handleChange(change) {
    if (this.destroyed || change?.layerId !== LAYER_ID) return;
    if (!String(change.type || '').startsWith('visibility')) return;
    this._syncEnabled();
    if (
      change.type === 'visibility' &&
      change.enabled &&
      change.notificationToken !== MISSION_LIST_REVEAL &&
      (!this._pendingReveal ||
        (change.intentEpoch === this._pendingReveal.epoch &&
          this._pendingReveal.current())) &&
      (change.origin === 'user' || change.origin === 'voice')
    )
      this._reveal();
  }

  /** Open Context on the Missions list, unless the Cockpit owns the screen. */
  _reveal({ keepFollow = true } = {}) {
    if (this.destroyed || this._actions.isCockpitActive?.()) return;
    this._actions.showMissions?.({ keepFollow });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._unsubscribeRequest?.();
    this._pendingReveal = null;
    this._unsubscribeManager?.();
    this._unsubscribeManager = null;
    this._unsubscribePanel?.();
    this._unsubscribePanel = null;
    this._unsubscribeGlobePick?.();
    this._unsubscribeGlobePick = null;
    this._store.connect(null);
    this._store.publish(null);
    this._store.setEnabled(false);
  }
}
