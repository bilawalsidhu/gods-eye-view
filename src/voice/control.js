/** Build the voice control independently of its connection backend. */
export function createVoiceControl({ reset = false } = {}) {
  let root = document.getElementById('gev-voice-control');
  let providerField = document.getElementById('gev-voice-provider-field');
  if (root && reset) {
    root.remove();
    providerField?.remove();
    root = null;
    providerField = null;
  }
  if (!root) {
    providerField = document.createElement('div');
    providerField.id = 'gev-voice-provider-field';
    providerField.className = 'gev-voice-provider-field';
    providerField.setAttribute('data-panel-surface', '');
    providerField.hidden = true;
    providerField.innerHTML = `
      <div data-panel-header class="gev-voice-provider-header">
        <span class="panel-surface-title">VOICE</span>
      </div>
      <div data-panel-body class="gev-voice-provider-controls">
        <select id="gev-voice-provider" class="panel-surface-control" aria-label="Voice provider" title="Changing provider stops the current voice session">
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
        </select>
        <button id="gev-voice-settings-button" class="panel-surface-control gev-voice-settings-button" type="button" aria-label="Voice settings" title="Voice settings" aria-expanded="false" aria-controls="gev-voice-settings-panel">
          <span class="material-symbols-outlined gev-voice-settings-icon" aria-hidden="true">settings</span>
          <span class="gev-voice-settings-label" aria-hidden="true">VOICE SETTINGS</span>
        </button>
      </div>
      <section id="gev-voice-settings-panel" data-panel-popup class="gev-voice-settings-panel" hidden aria-label="Voice Settings">
        <div data-panel-header>
          <span class="panel-surface-title">VOICE SETTINGS</span>
          <button id="gev-voice-settings-close" class="panel-surface-control" type="button" aria-label="Close Voice Settings">CLOSE</button>
        </div>
        <div data-panel-body>
          <fieldset class="gev-voice-inactivity-fieldset" aria-describedby="gev-voice-inactivity-note gev-voice-provider-limit-note">
            <legend>INACTIVITY TIMEOUT</legend>
            <div class="gev-voice-inactivity-chips">
              <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="3" /><span>3 min</span></label>
              <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="5" /><span>5 min</span></label>
              <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="10" /><span>10 min</span></label>
              <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="15" /><span>15 min</span></label>
              <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="custom" /><span>Custom</span></label>
              <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="none" /><span>None</span></label>
            </div>
          </fieldset>
          <label class="gev-voice-inactivity-custom" for="gev-voice-inactivity-custom" hidden>
            <span class="gev-voice-inactivity-custom-heading">
              <span>CUSTOM DURATION</span>
              <output id="gev-voice-inactivity-custom-value" for="gev-voice-inactivity-custom">5 min</output>
            </span>
            <input id="gev-voice-inactivity-custom" type="range" min="1" max="60" step="1" value="5" aria-describedby="gev-voice-inactivity-note gev-voice-provider-limit-note" />
            <span class="gev-voice-inactivity-range-scale" aria-hidden="true"><span>1 min</span><span>60 min</span></span>
          </label>
          <p id="gev-voice-inactivity-note" class="gev-voice-settings-note" aria-live="polite"></p>
          <section class="gev-voice-cost-settings" aria-label="OpenAI session settings" hidden>
            <div class="gev-voice-settings-section-title">OPENAI SESSION</div>
            <div class="gev-voice-cost-setting-row">
              <span><strong>MODEL TIER</strong><small>Applies next session</small></span>
              <button id="gev-voice-tier" class="panel-surface-control gev-voice-tier-btn" type="button" aria-pressed="false" title="Voice model tier — applies next session">STD</button>
            </div>
            <div class="gev-voice-cost-setting-row">
              <span><strong>ESTIMATED COST</strong><small>Current session</small></span>
              <output id="gev-voice-cost-value" class="gev-voice-cost-value" data-level="ok" title="Estimated session cost">~$0.00</output>
            </div>
          </section>
          <p id="gev-voice-provider-limit-note" class="gev-voice-settings-note gev-voice-provider-limit-note"></p>
        </div>
      </section>
    `;
    root = document.createElement('div');
    root.id = 'gev-voice-control';
    root.dataset.status = 'idle';
    root.dataset.speaker = 'idle';
    root.innerHTML = `
      <div class="gev-voice-heading">
        <div class="gev-voice-kicker">AI AGENT</div>
        <div id="gev-voice-status">OFF</div>
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
        <span class="gev-voice-help-kicker">VOICE CONTROL</span>
        <span class="gev-voice-help-detail">Hold Space to speak · tap Space to activate focused controls</span>
      </div>
      <div class="gev-voice-error-tray" role="alert" aria-live="assertive">
        <div class="gev-voice-error-header">
          <span>VOICE SYSTEM ERROR</span>
          <button class="gev-voice-error-dismiss" type="button">DISMISS</button>
        </div>
        <div id="gev-voice-error-detail"></div>
        <div class="gev-voice-error-hint">Check microphone permission and network access, then try again.</div>
      </div>
    `;
    const commandDock = document.getElementById('command-dock');
    if (commandDock) {
      const locationBar = document.getElementById('location-bar');
      const controlPanel = document.getElementById('control-panel');
      commandDock.appendChild(providerField);
      commandDock.appendChild(root);
      if (locationBar) commandDock.insertBefore(locationBar, root);
      if (controlPanel) commandDock.appendChild(controlPanel);
    } else {
      document.body.appendChild(providerField);
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
    providerField,
    providerSelect: providerField?.querySelector('#gev-voice-provider'),
    voiceSettingsButton: providerField?.querySelector(
      '#gev-voice-settings-button',
    ),
    voiceSettingsPanel: providerField?.querySelector(
      '#gev-voice-settings-panel',
    ),
    voiceSettingsClose: providerField?.querySelector(
      '#gev-voice-settings-close',
    ),
    inactivityOptions: providerField?.querySelectorAll(
      'input[name="gev-voice-inactivity"]',
    ),
    inactivityCustomRow: providerField?.querySelector(
      '.gev-voice-inactivity-custom',
    ),
    inactivityCustomInput: providerField?.querySelector(
      '#gev-voice-inactivity-custom',
    ),
    inactivityCustomValue: providerField?.querySelector(
      '#gev-voice-inactivity-custom-value',
    ),
    inactivityNote: providerField?.querySelector('#gev-voice-inactivity-note'),
    providerLimitNote: providerField?.querySelector(
      '#gev-voice-provider-limit-note',
    ),
    button: root.querySelector('#gev-voice-button'),
    buttonLabel: root.querySelector('.gev-mic-label'),
    status: root.querySelector('#gev-voice-status'),
    detail: root.querySelector('#gev-voice-detail'),
    helpDetail: root.querySelector('.gev-voice-help-detail'),
    errorDetail: root.querySelector('#gev-voice-error-detail'),
    errorHint: root.querySelector('.gev-voice-error-hint'),
    costSettings: providerField?.querySelector('.gev-voice-cost-settings'),
    tierButton: providerField?.querySelector('#gev-voice-tier'),
    costValue: providerField?.querySelector('#gev-voice-cost-value'),
  };
}
