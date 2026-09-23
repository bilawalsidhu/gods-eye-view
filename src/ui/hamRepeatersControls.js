import { renderHamRepeatersState } from './hamRepeatersPresentation.js';

/**
 * Own the Repeaters panel DOM (enable, radius, filters, LOAD HERE, the area
 * line and the list) and receive the layer and application actions. Camera
 * reading, loading and marker rendering stay with the layer.
 */
export class HamRepeatersControls {
  constructor({ elements, layer, actions }) {
    Object.assign(this, elements);
    this.layer = layer;
    this.actions = actions;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._unsubscribe = null;
    this._state = null;
    this._bind();
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  connect() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.destroyed) return;
    this._unsubscribe = this.layer.subscribe?.((state) =>
      this._renderState(state),
    );
  }

  _renderState(state) {
    renderHamRepeatersState.call(this, state);
  }

  _note(element, text, { error = false } = {}) {
    if (!element) return;
    element.textContent = text || '';
    element.classList.toggle('error', Boolean(error) && Boolean(text));
  }

  _bind() {
    if (!this._hamRepeatersPanel) return;
    const toggle = async () => {
      if (this.destroyed || !this.actions.isRegistered()) return;
      const enabling = !this.actions.isEnabled();
      const trigger = this._hamRepeatersEnableBtn;
      if (trigger) trigger.disabled = true;
      try {
        await this.actions.runUserAction(
          (notificationToken) =>
            this.actions.setEnabled(enabling, {
              origin: 'user',
              notificationToken,
            }),
          `Repeaters could not ${enabling ? 'start' : 'stop'} cleanly`,
        );
      } finally {
        if (trigger && !this.destroyed) trigger.disabled = false;
      }
    };
    this.listen(this._hamRepeatersEnableBtn, 'click', () => void toggle());
    this.listen(this._hamRepeatersBand, 'change', () => {
      this.layer.setFilter({ band: this._hamRepeatersBand.value });
    });
    this.listen(this._hamRepeatersKind, 'change', () => {
      this.layer.setFilter({ kind: this._hamRepeatersKind.value });
    });
    this.listen(
      this._hamRepeatersLoadBtn,
      'click',
      () => void this._loadHere(),
    );
    this.listen(document, 'gev:ham-repeater-selected', () => {
      this.actions.setPanelCollapsed('ham-repeaters-panel', false, {
        explicit: true,
      });
    });
    this.listen(document, 'gev:ham-repeaters-panel', () => {
      this.actions.setPanelCollapsed('ham-repeaters-panel', false, {
        explicit: true,
      });
    });
  }

  /** LOAD HERE: switch the layer on when needed, then load around the view centre. */
  async _loadHere() {
    if (this.destroyed) return;
    const trigger = this._hamRepeatersLoadBtn;
    if (trigger) trigger.disabled = true;
    try {
      if (!this.actions.isRegistered()) return;
      if (!this.actions.isEnabled()) {
        const result = await this.actions.runUserAction(
          (notificationToken) =>
            this.actions.setEnabled(true, {
              origin: 'user',
              notificationToken,
            }),
          'Repeaters could not start cleanly',
        );
        if (result === false || !this.actions.isEnabled() || this.destroyed)
          return;
      }
      const centre = this.actions.readViewCentre();
      if (!centre) {
        this._note(
          this._hamRepeatersArea,
          'The view centre could not be read',
          {
            error: true,
          },
        );
        return;
      }
      const radiusKm = Number(this._hamRepeatersRadius?.value) || 100;
      const result = await this.layer.loadAround(
        centre.lat,
        centre.lon,
        radiusKm,
        {
          origin: 'user',
          reason: 'panel',
        },
      );
      // A panel torn down while the load was in flight must not write into a
      // detached — or, after a shell re-init, a reused — area line.
      if (this.destroyed) return;
      if (
        result &&
        !result.ok &&
        result.error &&
        result.error !== 'superseded' &&
        result.error !== 'cancelled'
      )
        this._note(this._hamRepeatersArea, result.error, { error: true });
    } finally {
      if (trigger && !this.destroyed) trigger.disabled = false;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}
