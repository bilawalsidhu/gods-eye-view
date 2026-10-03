import { createVoiceControl } from './control.js';
import { createVoiceSession } from './session.js';
import {
  bindVoiceInactivitySettings,
  createDeferredVoiceSettingsIntent,
  createVoiceInactivityController,
} from './inactivity.js';

const DEFAULT_ERROR_HINT =
  'Check microphone permission and network access, then try again.';

/** Bind common controls to a supplied voice-session adapter. */
export function createVoiceCommands({
  runner,
  dataManager,
  annotations = null,
  createSession,
  createController,
  backend,
  signal,
  debugSink,
  createControl = createVoiceControl,
  resetExisting = true,
  provider,
  onProviderChange,
  onSessionEvent,
  storage,
  showToast,
  voiceSettingsOpen = false,
}) {
  if (resetExisting) window.__gevVoiceCommands?.stop?.({ removeUi: true });
  const ui = createControl({ reset: true });
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter: (hooks) =>
      createSession({
        ...hooks,
        runner,
        ui,
        dataManager,
        backend,
        debugSink,
        createController,
        radioLayer: dataManager?.layers?.get('radio')?.module || null,
      }),
  });
  const adapter = session.adapter;
  const capabilities = adapter.capabilities || {};
  let settingsUnsubscribe;
  const inactivity = createVoiceInactivityController({
    session,
    onExpire: () => settingsUnsubscribe?.setOpen?.(false),
  });
  const inactivityUnsubscribe = session.subscribe((event) =>
    inactivity.handleEvent(event),
  );
  settingsUnsubscribe = bindVoiceInactivitySettings({
    ui,
    storage,
    controller: inactivity,
    initialOpen: voiceSettingsOpen,
  });
  const deferredSettings = createDeferredVoiceSettingsIntent({
    open: () => settingsUnsubscribe.setOpen?.(true),
    onExpire: () =>
      showToast?.(
        'Voice Settings request expired — exit Cockpit and ask again.',
      ),
  });
  if (ui.providerLimitNote)
    ui.providerLimitNote.textContent = capabilities.advisoryLimit || '';
  const providerHandler = () => onProviderChange?.(ui.providerSelect.value);
  if (ui.providerField) ui.providerField.hidden = !onProviderChange;
  if (ui.providerSelect && onProviderChange) {
    ui.providerSelect.value = provider;
    ui.root.dataset.provider = provider;
    ui.providerSelect.addEventListener('change', providerHandler);
  }
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (ui.costSettings) ui.costSettings.hidden = !capabilities.costControls;
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', 'Toggle voice control');
    if (ui.helpDetail) ui.helpDetail.textContent = 'Activate to toggle voice';
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  controls.ui = ui;
  controls.setVoiceSettingsOpen = (open) =>
    settingsUnsubscribe.setOpen?.(open) ?? false;
  controls.deferVoiceSettingsUntilCockpitExit = () =>
    deferredSettings.schedule();
  controls.cancelDeferredVoiceSettings = () => deferredSettings.cancel();
  controls.setVoiceInactivityMinutes = (minutes) =>
    settingsUnsubscribe.setPreference?.(minutes) ?? false;
  controls.getVoiceInactivityMinutes = () =>
    settingsUnsubscribe.getPreference?.();
  const updateStatus = session.subscribe((event) => {
    // Terminal disclosure closes before a pending replacement can remount it.
    if (
      event.type === 'stop' ||
      (event.type === 'state' && ['idle', 'error'].includes(event.state))
    ) {
      deferredSettings.cancel();
      settingsUnsubscribe.setOpen?.(false);
    }
    onSessionEvent?.(event);
    if (event.type !== 'state') return;
    ui.root.dataset.status = event.state;
    ui.status.textContent =
      event.state === 'idle' ? 'OFF' : event.state.toUpperCase();
    ui.detail.textContent =
      event.detail || (event.state === 'idle' ? 'Voice off' : 'Voice active');
    ui.button.setAttribute('aria-pressed', String(session.isActive()));
    if (ui.errorDetail)
      ui.errorDetail.textContent =
        event.state === 'error'
          ? event.detail || 'Voice could not be started.'
          : '';
    if (ui.errorHint)
      ui.errorHint.textContent =
        event.state === 'error' && event.recovery
          ? event.recovery
          : DEFAULT_ERROR_HINT;
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
  });
  const annotationUnsubscribe = annotations?.onOutlineEvent?.((event) => {
    session.sendMapEvent({ type: 'map_annotation_outline', ...event });
  });
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    if (session.isActive()) {
      settingsUnsubscribe.setOpen?.(false);
      session.stop();
    } else void session.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', buttonHandler);
  session.signal.addEventListener(
    'abort',
    () => {
      ui.button.removeEventListener('click', buttonHandler);
      ui.providerSelect?.removeEventListener('change', providerHandler);
      settingsUnsubscribe();
      deferredSettings.destroy();
      inactivityUnsubscribe();
      inactivity.destroy();
      annotationUnsubscribe?.();
      updateStatus();
      ui.providerField?.remove?.();
      ui.root.remove();
    },
    { once: true },
  );
  if (session.disposed) {
    ui.button.removeEventListener('click', buttonHandler);
    ui.providerSelect?.removeEventListener('change', providerHandler);
    settingsUnsubscribe();
    deferredSettings.destroy();
    inactivityUnsubscribe();
    inactivity.destroy();
    annotationUnsubscribe?.();
    updateStatus();
    ui.providerField?.remove?.();
    ui.root.remove();
  } else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
