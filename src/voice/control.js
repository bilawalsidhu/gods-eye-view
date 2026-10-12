import { t } from '../i18n/index.js';
import { applyStaticTranslations } from '../ui/staticI18n.js';

/**
 * Build the voice control independently of its connection backend.
 *
 * Static markup keeps its English text (source of truth) tagged with
 * `data-i18n` / `data-i18n-attr`; the tag below translates it for the active
 * locale immediately (the control is built after boot, so the document-wide
 * binder's boot pass never saw it) and main.js's locale subscription reapplies
 * on every switch. Elements repainted by feature code (status, detail, cost,
 * help tray, card contents) carry NO data-i18n — their owners translate at
 * render time, and their initial paint below also goes through `t()`.
 */
export function createVoiceControl({ reset = false } = {}) {
  let root = document.getElementById('gev-voice-control');
  let built = false;
  if (root && reset) {
    root.remove();
    root = null;
  }
  if (!root) {
    built = true;
    root = document.createElement('div');
    root.id = 'gev-voice-control';
    root.dataset.status = 'idle';
    root.dataset.speaker = 'idle';
    root.innerHTML = `
      <div class="gev-voice-heading">
        <div class="gev-voice-kicker" data-i18n="voice.control.kicker">AI AGENT</div>
        <div id="gev-voice-status">OFF</div>
        <div class="gev-voice-cost">
          <button id="gev-voice-tier" class="gev-voice-tier-btn" type="button" aria-pressed="false" title="Voice model tier — applies next session">STD</button>
          <span id="gev-voice-cost-value" class="gev-voice-cost-value" data-level="ok" title="Estimated session cost">~$0.00</span>
        </div>
      </div>
      <button id="gev-voice-button" type="button" aria-label="Voice control — activate to toggle voice; hold Space to speak" aria-describedby="gev-voice-help">
        <span class="gev-mic-orbit"><img src="/mic.svg" alt="" /></span>
        <span class="gev-mic-label">ON/OFF</span>
      </button>
      <div class="gev-voice-visualizer" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="--bar:${index}"></span>`).join('')}
      </div>
      <div class="gev-voice-readout">
        <div id="gev-voice-detail">VOICE STANDBY</div>
      </div>
      <div id="gev-voice-help" class="gev-voice-help-tray" role="tooltip">
        <span class="gev-voice-help-kicker" data-i18n="voice.hint.trayKicker">VOICE CONTROL</span>
        <span class="gev-voice-help-detail">Hold Space to speak · tap Space to activate focused controls</span>
      </div>
      <section id="gev-voice-card" class="gev-voice-card" hidden aria-label="Voice assistant" data-i18n-attr="aria-label:voice.card.assistantAria">
        <div class="gev-voice-card-header">
          <span class="gev-voice-card-kicker" data-i18n="voice.card.kicker">VOICE</span>
          <span id="gev-voice-card-phase" class="gev-voice-card-phase"></span>
          <button id="gev-voice-card-dismiss" class="gev-voice-card-dismiss" type="button" aria-label="Dismiss voice card" data-i18n-attr="aria-label:voice.card.dismiss">×</button>
        </div>
        <p id="gev-voice-card-user" class="gev-voice-card-caption" data-role="user" hidden><span class="gev-voice-card-who" data-i18n="voice.card.whoUser">YOU</span><span id="gev-voice-card-user-text" class="gev-voice-card-text"></span></p>
        <p id="gev-voice-card-pointer" class="gev-voice-card-pointer" hidden><span id="gev-voice-card-pointer-kind" class="gev-voice-card-who">THIS</span><span class="gev-voice-card-sr">: </span><span id="gev-voice-card-pointer-text" class="gev-voice-card-pointer-label"></span></p>
        <p id="gev-voice-card-assistant" class="gev-voice-card-caption" data-role="assistant" hidden><span class="gev-voice-card-who" data-i18n="voice.card.whoGev">GEV</span><span id="gev-voice-card-assistant-text" class="gev-voice-card-text"></span></p>
        <ol id="gev-voice-card-plan" class="gev-voice-card-plan" aria-label="Plan" data-i18n-attr="aria-label:voice.card.planAria" hidden></ol>
        <div id="gev-voice-card-result" class="gev-voice-card-result" hidden>
          <div id="gev-voice-card-result-title" class="gev-voice-card-result-title"></div>
          <div id="gev-voice-card-chips" class="gev-voice-card-chips" hidden></div>
          <ul id="gev-voice-card-lines" class="gev-voice-card-lines"></ul>
          <ol id="gev-voice-card-referents" class="gev-voice-card-referents" aria-label="Referenced items" data-i18n-attr="aria-label:voice.card.referentsAria" hidden></ol>
          <details id="gev-voice-card-notes" class="gev-voice-card-notes" hidden>
            <summary data-i18n="voice.card.notesSummary">NOTES &amp; SOURCES</summary>
            <ul id="gev-voice-card-note-list" class="gev-voice-card-lines"></ul>
          </details>
        </div>
        <div id="gev-voice-card-live" class="gev-voice-card-sr" aria-live="polite" aria-atomic="true"></div>
      </section>
      <div class="gev-voice-error-tray" role="alert" aria-live="assertive">
        <div class="gev-voice-error-header">
          <span data-i18n="voice.error.title">VOICE SYSTEM ERROR</span>
          <button class="gev-voice-error-dismiss" type="button" data-i18n="voice.error.dismiss">DISMISS</button>
        </div>
        <div id="gev-voice-error-detail"></div>
        <div class="gev-voice-error-hint" data-i18n="voice.error.hint">Check microphone permission and network access, then try again.</div>
      </div>
    `;
    const commandDock = document.getElementById('command-dock');
    if (commandDock) {
      const locationBar = document.getElementById('location-bar');
      const controlPanel = document.getElementById('control-panel');
      commandDock.appendChild(root);
      if (locationBar) commandDock.insertBefore(locationBar, root);
      if (controlPanel) commandDock.appendChild(controlPanel);
    } else {
      document.body.appendChild(root);
    }
    root
      .querySelector('.gev-voice-error-dismiss')
      ?.addEventListener('click', () => {
        root.classList.add('error-dismissed');
      });
  }
  const ui = {
    root,
    button: root.querySelector('#gev-voice-button'),
    buttonLabel: root.querySelector('.gev-mic-label'),
    status: root.querySelector('#gev-voice-status'),
    detail: root.querySelector('#gev-voice-detail'),
    helpDetail: root.querySelector('.gev-voice-help-detail'),
    errorDetail: root.querySelector('#gev-voice-error-detail'),
    tierButton: root.querySelector('#gev-voice-tier'),
    costValue: root.querySelector('#gev-voice-cost-value'),
    card: root.querySelector('#gev-voice-card'),
  };
  // Translate the tagged static markup for the active locale now; the
  // document-wide binder reapplies it on every locale switch.
  if (built) {
    applyStaticTranslations(root);
    // Initial paint for elements repainted by feature code — their owners
    // (controller, cost meter, input owner) re-translate them at render
    // time, so they must not carry data-i18n.
    ui.status.textContent = t('voice.status.idle');
    ui.detail.textContent = t('voice.status.standby');
    ui.tierButton.title = t('voice.control.tierTitle');
    ui.costValue.title = t('voice.control.costTitle');
    ui.button.setAttribute('aria-label', t('voice.hint.micAria'));
    ui.buttonLabel.textContent = t('voice.control.onOff');
    ui.helpDetail.textContent = t('voice.hint.tray');
  }
  return ui;
}
