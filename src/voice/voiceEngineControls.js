import { syncChipGroup } from '../ui/chipGroup.js';
import { UiLifetime } from '../ui/uiLifetime.js';
import { probeDevice, voiceEngineView } from './voiceEnginePresentation.js';

export const VOICE_ENGINE_TRAY_ID = 'gev-voice-engine-tray';

const setText = (element, text) => {
  if (element && element.textContent !== text) element.textContent = text;
};

/**
 * Cloud / On-device choice nested in the voice control: a heading toggle
 * and a tray with the two engines, a hardware check with plain guidance,
 * and a slot where the on-device provider mounts its model settings.
 * Choosing an engine calls `onSelect`; the caller persists it and restarts
 * voice on the new engine.
 */
export class VoiceEngineControls {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root The voice control root.
   * @param {'cloud'|'on-device'} options.engine The running engine.
   * @param {(engine: string) => void} [options.onSelect]
   * @param {() => Promise<object>} [options.probe] Hardware probe.
   * @param {boolean} [options.open] Start with the tray open.
   */
  constructor({
    root,
    engine,
    onSelect = () => {},
    probe = probeDevice,
    open = false,
  }) {
    this.root = root;
    this.engine = engine;
    this.onSelect = onSelect;
    this.probeDevice = probe;
    this.probe = null;
    this.probing = null;
    this.badge = null;
    this.open = false;
    this.lifetime = new UiLifetime();
    const document = root?.ownerDocument;
    if (!document?.createElement) return;
    const make = (tag, className, parent, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      parent?.appendChild(node);
      return node;
    };

    this.toggle = make('button', 'gev-voice-tier-btn gev-voice-engine-toggle');
    this.toggle.id = 'gev-voice-engine-toggle';
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-controls', VOICE_ENGINE_TRAY_ID);
    this.toggle.setAttribute('aria-expanded', 'false');
    const cluster =
      root.querySelector('.gev-voice-cost') ||
      root.querySelector('.gev-voice-heading') ||
      root;
    cluster.insertBefore(this.toggle, cluster.children?.[0] || null);

    const tray = make('div', 'gev-voice-engine-tray', root);
    tray.id = VOICE_ENGINE_TRAY_ID;
    tray.setAttribute('role', 'group');
    tray.setAttribute('aria-label', 'Where voice runs');
    const heading = make('div', 'gev-voice-local-heading', tray);
    make('span', 'gev-voice-local-kicker', heading, 'VOICE RUNS ON');
    const chips = make('div', 'gev-voice-local-chips', tray);
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Voice engine');
    const description = make('p', 'gev-voice-local-hint', tray);
    const device = make('div', 'gev-voice-engine-device', tray);
    const deviceHeading = make('div', 'gev-voice-local-heading', device);
    make('span', 'gev-voice-local-label', deviceHeading, 'THIS DEVICE');
    const gpu = make('span', 'gev-voice-engine-fact', device);
    const memory = make('span', 'gev-voice-engine-fact', device);
    const guidance = make('ul', 'gev-voice-engine-guidance', device);
    guidance.setAttribute('aria-label', 'Hardware guidance');
    const verdict = make('p', 'gev-voice-engine-verdict', device);
    verdict.setAttribute('role', 'status');
    // The on-device provider renders its model settings here.
    this.slot = make('div', 'gev-voice-local-slot', tray);
    this.tray = tray;
    this.elements = {
      chips,
      description,
      device,
      gpu,
      memory,
      guidance,
      verdict,
    };
    root.dataset.voiceEngine = engine;

    this.lifetime.listen(this.toggle, 'click', (event) => {
      event.stopPropagation?.();
      this.setOpen(!this.open);
    });
    this.lifetime.listen(chips, 'click', (event) => {
      const button = event.target?.closest?.('[data-chip-id]');
      const id = button?.dataset.chipId;
      if (!id || button.disabled || id === this.engine) return;
      this.onSelect(id);
    });
    if (typeof document.addEventListener === 'function')
      this.lifetime.listen(document, 'keydown', (event) => {
        if (event.key === 'Escape' && this.open) this.setOpen(false);
      });
    this.render();
    // A saved on-device choice checks the hardware straight away so the
    // tray can explain a refusal before voice starts.
    if (open) this.setOpen(true);
    else if (engine === 'on-device') this.checkDevice();
  }

  /** Runs the hardware probe once; later calls reuse it. */
  checkDevice() {
    if (this.probing || this.lifetime.destroyed) return this.probing;
    this.probing = Promise.resolve()
      .then(() => this.probeDevice())
      .catch(() => ({ webgpu: false, secure: true }))
      .then((probe) => {
        this.probe = probe;
        this.render();
        return probe;
      });
    return this.probing;
  }

  setOpen(open) {
    this.open = Boolean(open);
    if (this.open) this.checkDevice();
    this.render();
  }

  /** Short label the on-device provider shows on the toggle (e.g. model). */
  setBadge(badge) {
    this.badge = badge || null;
    this.render();
  }

  render() {
    if (this.lifetime.destroyed || !this.tray) return;
    const view = voiceEngineView({
      engine: this.engine,
      probe: this.probe,
      badge: this.badge,
    });
    const el = this.elements;
    setText(this.toggle, view.toggleLabel);
    this.toggle.title = view.toggleTitle;
    this.toggle.setAttribute('aria-expanded', String(this.open));
    this.toggle.classList.toggle('active', this.open);
    if (this.open) this.root.dataset.voiceTray = 'open';
    else delete this.root.dataset.voiceTray;
    syncChipGroup(el.chips, view.chips);
    setText(el.description, view.description);
    setText(el.gpu, view.device.gpu);
    el.memory.hidden = !view.device.memory;
    setText(el.memory, view.device.memory);
    if (el.guidance.children.length !== view.guidance.length) {
      for (const item of [...el.guidance.children]) item.remove();
      for (const line of view.guidance) {
        const item = this.root.ownerDocument.createElement('li');
        item.textContent = line;
        el.guidance.appendChild(item);
      }
    }
    el.verdict.hidden = !view.device.verdict;
    setText(el.verdict, view.device.verdict);
    el.verdict.classList.toggle('error', view.unsupported);
  }

  destroy() {
    this.lifetime.destroy();
    this.toggle?.remove();
    this.tray?.remove();
    if (this.root?.dataset) {
      delete this.root.dataset.voiceTray;
      delete this.root.dataset.voiceEngine;
    }
  }
}
