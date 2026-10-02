import { createVoiceControl } from './control.js';
import { createVoiceSession } from './session.js';
import { VoiceCardControls } from './voiceCard.js';
import { PointerReticle } from './pointerReticle.js';
import { VoiceEngineControls } from './voiceEngineControls.js';

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
  createCard = (options) => new VoiceCardControls(options),
  pointer = null,
  referents = null,
  createReticle = createDefaultReticle,
  engineChoice = null,
  createEngineControls = (options) => new VoiceEngineControls(options),
}) {
  window.__gevVoiceCommands?.stop?.({ removeUi: true });
  const ui = createControl({ reset: true });
  // Cloud / On-device choice; the on-device provider mounts its model
  // settings in this tray.
  const engineControls =
    engineChoice && ui.root
      ? createEngineControls({
          root: ui.root,
          engine: engineChoice.engine,
          onSelect: engineChoice.select,
          open: Boolean(engineChoice.openTray),
        })
      : null;
  ui.engineControls = engineControls;
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
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', 'Toggle voice control');
    if (ui.helpDetail) ui.helpDetail.textContent = 'Activate to toggle voice';
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  const updateStatus = session.subscribe((event) => {
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
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
  });
  // Captions, plan and result card nested in the control; it only reads
  // provider-neutral session events.
  const card = ui.card ? createCard({ root: ui.root }) : null;
  const updateCard = card
    ? session.subscribe((event) => card.handle(event))
    : null;
  controls.voiceCard = card;
  controls.engineControls = engineControls;
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
  const annotationUnsubscribe = annotations?.onOutlineEvent?.((event) => {
    card?.outline(event);
    session.sendMapEvent({ type: 'map_annotation_outline', ...event });
  });
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    if (session.isActive()) session.stop();
    else void session.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', buttonHandler);
  session.signal.addEventListener(
    'abort',
    () => {
      ui.button.removeEventListener('click', buttonHandler);
      annotationUnsubscribe?.();
      updateStatus();
      updateCard?.();
      updatePointer();
      reticle?.destroy();
      card?.destroy();
      engineControls?.destroy();
      runner.dispose?.();
      ui.root.remove();
    },
    { once: true },
  );
  if (session.disposed) {
    ui.button.removeEventListener('click', buttonHandler);
    annotationUnsubscribe?.();
    updateStatus();
    updateCard?.();
    updatePointer();
    reticle?.destroy();
    card?.destroy();
    engineControls?.destroy();
    runner.dispose?.();
    ui.root.remove();
  } else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
