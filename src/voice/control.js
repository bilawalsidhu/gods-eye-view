import { t } from '../i18n/index.js';

/** Build the voice control independently of its connection backend. */
export function createVoiceControl({ reset = false } = {}) {
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
      <div class="gev-voice-heading">
        <div class="gev-voice-kicker">${t('setup.voice.kicker.agent')}</div>
        <div id="gev-voice-status">${t('setup.voice.status.idle')}</div>
        <div class="gev-voice-cost">
          <button id="gev-voice-tier" class="gev-voice-tier-btn" type="button" aria-pressed="false" title="${t('setup.voice.tier.buttonTitle')}">STD</button>
          <span id="gev-voice-cost-value" class="gev-voice-cost-value" data-level="ok" title="${t('setup.voice.cost.buttonTitle')}">~$0.00</span>
        </div>
      </div>
      <button id="gev-voice-button" type="button" aria-label="${t('setup.voice.button.ariaLabel')}" aria-describedby="gev-voice-help">
        <span class="gev-mic-orbit"><img src="/mic.svg" alt="" /></span>
        <span class="gev-mic-label">ON/OFF</span>
      </button>
      <div class="gev-voice-visualizer" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="--bar:${index}"></span>`).join('')}
      </div>
      <div class="gev-voice-readout">
        <div id="gev-voice-detail">${t('setup.voice.detail.standby')}</div>
      </div>
      <div id="gev-voice-help" class="gev-voice-help-tray" role="tooltip">
        <span class="gev-voice-help-kicker">${t('setup.voice.kicker.control')}</span>
        <span class="gev-voice-help-detail">${t('setup.voice.hint.default')}</span>
      </div>
      <div class="gev-voice-error-tray" role="alert" aria-live="assertive">
        <div class="gev-voice-error-header">
          <span>${t('setup.voice.error.trayTitle')}</span>
          <button class="gev-voice-error-dismiss" type="button">${t('setup.voice.error.dismiss')}</button>
        </div>
        <div id="gev-voice-error-detail"></div>
        <div class="gev-voice-error-hint">${t('setup.voice.error.hint')}</div>
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
    button: root.querySelector('#gev-voice-button'),
    buttonLabel: root.querySelector('.gev-mic-label'),
    status: root.querySelector('#gev-voice-status'),
    detail: root.querySelector('#gev-voice-detail'),
    helpDetail: root.querySelector('.gev-voice-help-detail'),
    errorDetail: root.querySelector('#gev-voice-error-detail'),
    tierButton: root.querySelector('#gev-voice-tier'),
    costValue: root.querySelector('#gev-voice-cost-value'),
  };
}
