import { createVoiceControl, voiceStatusLabel } from './control.js';
import { createVoiceSession } from './session.js';
import { VoiceCardControls } from './voiceCard.js';
import { PointerReticle } from './pointerReticle.js';
import { VOICE_PROVIDERS } from './providerCapabilities.js';
import { msg, registerUnsavedWork, t } from '../i18n/index.js';

function createDefaultReticle(pointer) {
  const element = pointer?.element;
  const doc = element?.ownerDocument;
  if (!doc) return null;
  return new PointerReticle({
    doc,
    rectOf: () => element.getBoundingClientRect?.() || null,
  });
}

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
  disposeRunner = true,
  provider,
  supportedProviders,
  onProviderChange,
  onSessionEvent,
  createCard = (options) => new VoiceCardControls(options),
  pointer = null,
  referents = null,
  createReticle = createDefaultReticle,
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
        pointer,
        radioLayer: dataManager?.layers?.get('radio')?.module || null,
      }),
  });
  const adapter = session.adapter;
  const capabilities = adapter.capabilities || {};
  const providerHandler = () => onProviderChange?.(ui.providerSelect.value);
  if (ui.providerSelect && onProviderChange) {
    if (supportedProviders && ui.providerSelect.replaceChildren) {
      const doc = ui.providerSelect.ownerDocument;
      ui.providerSelect.replaceChildren(
        ...supportedProviders.map((name) => {
          const option = doc.createElement('option');
          option.value = name;
          option.textContent = VOICE_PROVIDERS[name].label;
          return option;
        }),
      );
    }
    ui.providerSelect.value = provider;
    ui.providerSelect.title = [
      t('Changing provider reconnects voice if it is on.'),
      capabilities.advisoryLimit,
    ]
      .filter(Boolean)
      .join(' ');
    ui.providerSelect.addEventListener('change', providerHandler);
    ui.root.dataset.provider = provider;
  }
  const hasProviderChoice = Boolean(
    onProviderChange && supportedProviders?.length > 1,
  );
  if (ui.providerField) ui.providerField.hidden = !hasProviderChoice;
  ui.root.dataset.providerChoice = String(hasProviderChoice);
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', t('Toggle voice control'));
    if (ui.helpDetail)
      ui.helpDetail.textContent = t('Activate to toggle voice');
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  controls.ui = ui;
  const updateStatus = session.subscribe((event) => {
    if (event.type !== 'state') return;
    ui.root.dataset.status = event.state;
    // States are machine values; only the label is translated.
    ui.status.textContent = voiceStatusLabel(event.state);
    // The portable session reports 'Voice off' in English: show the idle
    // label instead. Other details are provider messages, shown as they come.
    const idle = event.state === 'idle';
    const detail = event.detail === 'Voice off' ? '' : event.detail;
    ui.detail.textContent =
      detail || (idle ? t('Voice off') : t('Voice active'));
    ui.button.setAttribute('aria-pressed', String(session.isActive()));
    if (ui.errorDetail)
      ui.errorDetail.textContent =
        event.state === 'error'
          ? event.detail || t('Voice could not be started.')
          : '';
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
  });
  // Captions, plan and result card nested in the control; it only reads
  // provider-neutral session events.
  const card = ui.card ? createCard({ root: ui.root }) : null;
  const updateCard = card
    ? session.subscribe((event) => card.handle(event))
    : null;
  controls.voiceCard = card;
  // Point-and-ask: the reticle follows turn events; pointer and referents are
  // session-scoped, so a session that ends forgets both.
  const reticle = pointer ? createReticle(pointer) : null;
  const updatePointer = session.subscribe((event) => {
    reticle?.handle(event);
    if (event.type === 'state' && ['idle', 'error'].includes(event.state)) {
      pointer?.clear();
      referents?.clear();
      // Conversation memory ("those", "the last answer") ends with the
      // session.
      runner.resetConversation?.();
    }
  });
  controls.pointer = pointer;
  controls.referents = referents;
  // Forward last: a host observer may synchronously replace or stop this mount.
  const forwardEvents = onSessionEvent
    ? session.subscribe(onSessionEvent)
    : null;
  const annotationUnsubscribe = annotations?.onOutlineEvent?.((event) => {
    card?.outline(event);
    session.sendMapEvent({ type: 'map_annotation_outline', ...event });
  });
  // A reload (the language switch) ends the conversation: ask first.
  const unregisterUnsavedWork = registerUnsavedWork(() =>
    session.isActive() ? msg('the active voice session') : null,
  );
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    if (session.isActive()) session.stop();
    else void session.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', buttonHandler);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    ui.button.removeEventListener('click', buttonHandler);
    ui.providerSelect?.removeEventListener('change', providerHandler);
    unregisterUnsavedWork();
    annotationUnsubscribe?.();
    updateStatus();
    updateCard?.();
    updatePointer();
    forwardEvents?.();
    reticle?.destroy();
    card?.destroy();
    if (disposeRunner) runner.dispose?.();
    ui.root.remove();
  };
  session.signal.addEventListener('abort', cleanup, { once: true });
  if (session.disposed) cleanup();
  else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
