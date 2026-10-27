import { t } from '../i18n/index.js';

// The assistant's name on its card. i18n-ignore: product name
const ASSISTANT_NAME = 'GEV';

/**
 * Short state label for the narrow voice heading. The `voice` context lets
 * languages use shorter words; unknown states show upper-cased.
 * @param {string} status machine state (dataset.status)
 * @returns {string}
 */
export function voiceStatusLabel(status) {
  switch (status) {
    case 'idle':
      return t('OFF', { context: 'voice' });
    case 'connecting':
      return t('CONNECTING', { context: 'voice' });
    case 'listening':
      return t('LISTENING', { context: 'voice' });
    case 'executing':
      return t('EXECUTING', { context: 'voice' });
    case 'error':
      return t('ERROR', { context: 'voice' });
    default:
      return String(status || '').toUpperCase();
  }
}

/** Build the voice control independently of its connection backend. */
export function createVoiceControl({ reset = false, panel = false } = {}) {
  let root = document.getElementById('gev-voice-control');
  if (root && reset) {
    root.remove();
    root = null;
  }
  if (!root) {
    root = document.createElement('div');
    root.id = 'gev-voice-control';
    root.dataset.status = 'idle';
    root.dataset.speaker = 'idle';
    root.innerHTML = `
      <label id="gev-voice-provider-field" class="gev-voice-provider-field" hidden>
        <span>${t('Voice provider')}</span>
        <select id="gev-voice-provider" aria-label="${t('Voice provider')}" title="${t('Changing provider reconnects voice if it is on.')}"></select>
      </label>
      ${panel ? `<button id="gev-voice-settings-button" class="gev-voice-settings-button" type="button" aria-label="${t('Voice Settings')}" aria-controls="gev-voice-panel" aria-expanded="false"><span class="material-symbols-outlined gev-voice-settings-icon" aria-hidden="true">settings</span></button>` : ''}
      <div class="gev-voice-heading">
        <div class="gev-voice-kicker">${t('AI AGENT')}</div>
        <div id="gev-voice-status">${voiceStatusLabel('idle')}</div>
        ${
          panel
            ? `<span id="gev-voice-cost-warning" class="gev-voice-cost-value gev-voice-cost-warning" hidden role="status" aria-live="polite"></span>`
            : `<div class="gev-voice-cost">
          <button id="gev-voice-tier" class="gev-voice-tier-btn" type="button" aria-pressed="false" title="${t('Voice model tier — applies next session')}">${t('STD')}</button>
          <span id="gev-voice-cost-value" class="gev-voice-cost-value" data-level="ok" title="${t('Estimated session cost')}">~$0.00</span>
        </div>`
        }
      </div>
      <button id="gev-voice-button" type="button" aria-label="${t('Voice control — activate to toggle voice; hold Space to speak')}" aria-describedby="gev-voice-help">
        <span class="gev-mic-orbit"><img src="/mic.svg" alt="" /></span>
        <span class="gev-mic-label">${t('ON/OFF')}</span>
      </button>
      <div class="gev-voice-visualizer" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="--bar:${index}"></span>`).join('')}
      </div>
      <div class="gev-voice-readout">
        <div id="gev-voice-detail">${t('VOICE STANDBY')}</div>
      </div>
      <div id="gev-voice-help" class="gev-voice-help-tray" role="tooltip">
        <span class="gev-voice-help-kicker">${t('VOICE CONTROL')}</span>
        <span class="gev-voice-help-detail">${t('Hold Space to speak · tap Space to activate focused controls')}</span>
      </div>
      ${
        panel
          ? `<section id="gev-voice-panel" class="gev-voice-panel" hidden aria-label="${t('Voice Settings')}">
        <div class="gev-voice-panel-header">
          <span class="gev-voice-panel-title">${t('VOICE')}</span>
          <div class="gev-voice-panel-tabs" role="tablist" aria-label="${t('Voice Settings')}">
            <button id="gev-voice-preview-tab" class="gev-voice-panel-tab" type="button" role="tab" aria-label="${t('Preview')}" title="${t('Preview')}" aria-selected="true" aria-controls="gev-voice-preview-panel"><span class="material-symbols-outlined gev-voice-panel-tab-icon" aria-hidden="true">visibility</span></button>
            <button id="gev-voice-settings-tab" class="gev-voice-panel-tab" type="button" role="tab" aria-label="${t('Settings')}" title="${t('Settings')}" aria-selected="false" tabindex="-1" aria-controls="gev-voice-settings-panel"><span class="material-symbols-outlined gev-voice-panel-tab-icon" aria-hidden="true">settings</span></button>
          </div>
          <button id="gev-voice-settings-close" type="button" aria-label="${t('Close voice panel')}">×</button>
        </div>
        <div class="gev-voice-panel-body">
          <section id="gev-voice-preview-panel" role="tabpanel" aria-labelledby="gev-voice-preview-tab">
            <p id="gev-voice-preview-empty">${t('Voice replies appear here.')}</p>`
          : ''
      }
      <section id="gev-voice-card" class="gev-voice-card" hidden aria-label="${t('Voice assistant')}">
        <div class="gev-voice-card-header">
          <span class="gev-voice-card-kicker">${t('VOICE')}</span>
          <span id="gev-voice-card-phase" class="gev-voice-card-phase"></span>
          <button id="gev-voice-card-dismiss" class="gev-voice-card-dismiss" type="button" aria-label="${t('Dismiss voice card')}">×</button>
        </div>
        <p id="gev-voice-card-user" class="gev-voice-card-caption" data-role="user" hidden><span id="gev-voice-card-user-who" class="gev-voice-card-who">${t('YOU')}</span><span id="gev-voice-card-user-text" class="gev-voice-card-text"></span></p>
        <p id="gev-voice-card-pointer" class="gev-voice-card-pointer" hidden><span id="gev-voice-card-pointer-kind" class="gev-voice-card-who">${t('THIS')}</span><span class="gev-voice-card-sr">: </span><span id="gev-voice-card-pointer-text" class="gev-voice-card-pointer-label"></span></p>
        <p id="gev-voice-card-assistant" class="gev-voice-card-caption" data-role="assistant" hidden><span class="gev-voice-card-who">${ASSISTANT_NAME}</span><span id="gev-voice-card-assistant-text" class="gev-voice-card-text"></span></p>
        <ol id="gev-voice-card-plan" class="gev-voice-card-plan" aria-label="${t('Plan')}" hidden></ol>
        <div id="gev-voice-card-result" class="gev-voice-card-result" hidden>
          <div id="gev-voice-card-result-title" class="gev-voice-card-result-title"></div>
          <div id="gev-voice-card-chips" class="gev-voice-card-chips" hidden></div>
          <ul id="gev-voice-card-lines" class="gev-voice-card-lines"></ul>
          <ol id="gev-voice-card-referents" class="gev-voice-card-referents" aria-label="${t('Referenced items')}" hidden></ol>
          <details id="gev-voice-card-notes" class="gev-voice-card-notes" hidden>
            <summary>${t('NOTES & SOURCES')}</summary>
            <ul id="gev-voice-card-note-list" class="gev-voice-card-lines"></ul>
          </details>
        </div>
        <div id="gev-voice-card-live" class="gev-voice-card-sr" aria-live="polite" aria-atomic="true"></div>
      </section>
      ${
        panel
          ? `</section>
          <section id="gev-voice-settings-panel" role="tabpanel" aria-labelledby="gev-voice-settings-tab" hidden>
            <label class="gev-voice-preference gev-voice-preference-toggle"><input id="gev-voice-preview-enabled" type="checkbox" checked aria-describedby="gev-voice-preview-note" /><span>${t('Show Voice Preview')}</span></label>
            <p id="gev-voice-preview-note" class="gev-voice-settings-note"></p>
            <div class="gev-voice-timeout-group">
            <label class="gev-voice-preference gev-voice-setting-title" for="gev-voice-timeout-select">${t('Voice inactivity timeout')}</label>
            <div class="gev-voice-timeout-controls">
            <select id="gev-voice-timeout-select" aria-describedby="gev-voice-timeout-note gev-voice-timeout-status">
              <option value="3">3 ${t('Minutes')}</option><option value="5" selected>5 ${t('Minutes')}</option><option value="10">10 ${t('Minutes')}</option><option value="15">15 ${t('Minutes')}</option>
              <option value="custom">${t('Custom')}</option><option value="0">${t('None')}</option>
            </select>
            <label class="gev-voice-timeout-unit" for="gev-voice-timeout-input">${t('Minutes')}</label>
            <input id="gev-voice-timeout-input" type="number" min="1" max="60" step="1" value="5" aria-describedby="gev-voice-timeout-note" />
            </div>
            <p id="gev-voice-timeout-note" class="gev-voice-settings-note">${t('These preferences stay in this browser.')}</p>
            <p id="gev-voice-timeout-status" class="gev-voice-settings-note" role="status" aria-live="polite"></p>
            </div>
            <div class="gev-voice-cost-settings">
              <div class="gev-voice-cost-setting-row">
                <span>${t('Voice model tier — applies next session')}</span>
                <button id="gev-voice-tier" class="gev-voice-tier-btn" type="button" aria-pressed="false" title="${t('Voice model tier — applies next session')}">${t('STD')}</button>
              </div>
              <div class="gev-voice-cost-setting-row">
                <span>${t('Estimated session cost')}</span>
                <span id="gev-voice-cost-value" class="gev-voice-cost-value" data-level="ok" title="${t('Estimated session cost')}">~$0.00</span>
              </div>
            </div>
          </section>
        </div>
      </section>`
          : ''
      }
      <div class="gev-voice-error-tray" role="alert" aria-live="assertive">
        <div class="gev-voice-error-header">
          <span>${t('VOICE SYSTEM ERROR')}</span>
          <button class="gev-voice-error-dismiss" type="button">${t('DISMISS')}</button>
        </div>
        <div id="gev-voice-error-detail"></div>
        <div class="gev-voice-error-hint">${t('Check microphone permission and network access, then try again.')}</div>
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
  return {
    root,
    voicePanel: root.querySelector('#gev-voice-panel'),
    previewPanel: root.querySelector('#gev-voice-preview-panel'),
    voiceSettingsPanel: root.querySelector('#gev-voice-settings-panel'),
    previewTab: root.querySelector('#gev-voice-preview-tab'),
    settingsTab: root.querySelector('#gev-voice-settings-tab'),
    voiceSettingsButton: root.querySelector('#gev-voice-settings-button'),
    voiceSettingsClose: root.querySelector('#gev-voice-settings-close'),
    previewEmpty: root.querySelector('#gev-voice-preview-empty'),
    voicePreviewInput: root.querySelector('#gev-voice-preview-enabled'),
    voicePreviewNote: root.querySelector('#gev-voice-preview-note'),
    voiceTimeoutSelect: root.querySelector('#gev-voice-timeout-select'),
    voiceTimeoutInput: root.querySelector('#gev-voice-timeout-input'),
    voiceTimeoutNote: root.querySelector('#gev-voice-timeout-note'),
    voiceTimeoutStatus: root.querySelector('#gev-voice-timeout-status'),
    providerField: root.querySelector('#gev-voice-provider-field'),
    providerSelect: root.querySelector('#gev-voice-provider'),
    button: root.querySelector('#gev-voice-button'),
    buttonLabel: root.querySelector('.gev-mic-label'),
    status: root.querySelector('#gev-voice-status'),
    detail: root.querySelector('#gev-voice-detail'),
    helpDetail: root.querySelector('.gev-voice-help-detail'),
    errorDetail: root.querySelector('#gev-voice-error-detail'),
    tierButton: root.querySelector('#gev-voice-tier'),
    costValue: root.querySelector('#gev-voice-cost-value'),
    costWarning: root.querySelector('#gev-voice-cost-warning'),
    card: root.querySelector('#gev-voice-card'),
  };
}
