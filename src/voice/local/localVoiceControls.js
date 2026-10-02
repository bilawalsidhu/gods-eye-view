import { syncChipGroup } from '../../ui/chipGroup.js';
import { UiLifetime } from '../../ui/uiLifetime.js';
import { localVoiceTrayView } from './localVoicePresentation.js';

const setText = (element, text) => {
  if (element && element.textContent !== text) element.textContent = text;
};

/**
 * On-device model settings, rendered into the voice engine tray's slot:
 * model, hearing and voice chips, download progress, device and storage
 * warnings. Captions and results stay in the shared voice card. Renders the
 * provider store; selection goes through actions. While models load or the
 * device is refused, the tray opens itself (data-local-tray).
 */
export class LocalVoiceControls {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root The voice control root.
   * @param {object} options.store Local voice store (getState, subscribe).
   * @param {object} [options.actions] selectModel(id), selectStt(id),
   *   selectTts(id), clearModels().
   * @param {object} [options.engineControls] The engine tray; supplies the
   *   slot and shows the model on its toggle.
   */
  constructor({ root, store, actions = {}, engineControls = null }) {
    this.root = root;
    this.store = store;
    this.actions = actions;
    this.engineControls = engineControls;
    this.lifetime = new UiLifetime();
    this.frame = null;
    const document = root?.ownerDocument;
    if (!document?.createElement) return;
    const make = (tag, className, parent, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      parent?.appendChild(node);
      return node;
    };

    const slot =
      engineControls?.slot ||
      root.querySelector?.('.gev-voice-local-slot') ||
      make('div', 'gev-voice-local-slot', root);
    const section = make('div', 'gev-voice-local-settings', slot);
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', 'On-device voice');
    const heading = make('div', 'gev-voice-local-heading', section);
    make('span', 'gev-voice-local-kicker', heading, 'ON-DEVICE MODELS');
    const state = make('span', 'gev-voice-local-state', heading);
    state.setAttribute('role', 'status');
    const chipRow = (label, aria) => {
      const row = make('div', 'gev-voice-local-row', section);
      make('span', 'gev-voice-local-label', row, label);
      const chips = make('div', 'gev-voice-local-chips', row);
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', aria);
      return chips;
    };
    const models = chipRow('MODEL', 'Language model');
    const stt = chipRow('HEARING', 'Speech recognition model');
    const tts = chipRow('VOICE', 'Speech output');
    const notice = make('p', 'gev-voice-local-notice', section);
    const progress = make('div', 'gev-voice-local-progress', section);
    const progressLabel = make(
      'span',
      'gev-voice-local-progress-label',
      progress,
    );
    const bar = make('div', 'gev-voice-local-bar', progress);
    const progressBar = make('span', '', bar);
    const note = make('div', 'gev-voice-local-note', section);
    const storage = make('div', 'gev-voice-local-storage', section);
    const clear = make(
      'button',
      'data-toggle-chip gev-voice-local-clear',
      storage,
    );
    clear.type = 'button';
    const storageMessage = make(
      'span',
      'gev-voice-local-storage-note',
      storage,
    );
    this.section = section;
    root.dataset.voiceProvider = 'local-web';
    this.elements = {
      state,
      models,
      stt,
      tts,
      notice,
      clear,
      storageMessage,
      progress,
      progressLabel,
      progressBar,
      note,
    };

    const chipClick = (action) => (event) => {
      const id = event.target?.closest?.('[data-chip-id]')?.dataset.chipId;
      if (id) this.actions[action]?.(id);
    };
    this.lifetime.listen(models, 'click', chipClick('selectModel'));
    this.lifetime.listen(stt, 'click', chipClick('selectStt'));
    this.lifetime.listen(tts, 'click', chipClick('selectTts'));
    this.lifetime.listen(clear, 'click', () => {
      if (!clear.disabled) this.actions.clearModels?.();
    });
    this.unsubscribe = store.subscribe(() => this.schedule());
    this.render();
  }

  schedule() {
    if (this.lifetime.destroyed || this.frame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.render();
      return;
    }
    this.frame = this.lifetime.frame(() => {
      this.frame = null;
      this.render();
    });
  }

  render() {
    if (this.lifetime.destroyed || !this.section) return;
    const view = localVoiceTrayView(this.store.getState());
    const el = this.elements;
    this.engineControls?.setBadge(view.badge);
    if (view.open) this.root.dataset.localTray = 'open';
    else delete this.root.dataset.localTray;
    setText(el.state, view.status);
    el.state.classList.toggle('error', view.statusError);
    syncChipGroup(el.models, view.modelChips);
    syncChipGroup(el.stt, view.sttChips);
    syncChipGroup(el.tts, view.ttsChips);
    el.notice.hidden = !view.notice;
    setText(el.notice, view.notice || '');
    setText(el.clear, view.clearLabel);
    el.clear.disabled = view.clearDisabled;
    el.storageMessage.hidden = !view.storageMessage;
    setText(el.storageMessage, view.storageMessage || '');
    el.progress.hidden = view.progressHidden;
    setText(el.progressLabel, view.progressLabel);
    el.progressBar.style.width = `${view.progressPercent}%`;
    el.note.hidden = !view.note;
    setText(el.note, view.note || '');
  }

  /** Removes the settings and listeners; the provider keeps its models. */
  destroy() {
    this.lifetime.destroy();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.section?.remove();
    this.engineControls?.setBadge(null);
    if (this.root?.dataset) {
      delete this.root.dataset.localTray;
      delete this.root.dataset.voiceProvider;
    }
  }
}
