import { createVoiceControl } from './control.js';
import { createVoiceSession } from './session.js';
import { VoiceCardControls } from './voiceCard.js';
import { PointerReticle } from './pointerReticle.js';
import { subscribeLocale, t } from '../i18n/index.js';

/** Status chip words, keyed by state (mirrors realtimeController). */
const STATUS_KEYS = {
  idle: 'voice.status.idle',
  connecting: 'voice.status.connecting',
  listening: 'voice.status.listening',
  executing: 'voice.status.executing',
  error: 'voice.status.error',
};

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
}) {
  window.__gevVoiceCommands?.stop?.({ removeUi: true });
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
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', t('voice.hint.toggleAria'));
    if (ui.helpDetail)
      ui.helpDetail.textContent = t('voice.hint.activateToggle');
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  const paintState = (event) => {
    ui.root.dataset.status = event.state;
    ui.status.textContent = t(STATUS_KEYS[event.state] || STATUS_KEYS.idle);
    ui.detail.textContent =
      event.detail ||
      (event.state === 'idle'
        ? t('voice.status.offDetail')
        : t('voice.status.onDetail'));
    ui.button.setAttribute('aria-pressed', String(session.isActive()));
    if (ui.errorDetail)
      ui.errorDetail.textContent =
        event.state === 'error'
          ? event.detail || t('voice.status.couldNotStart')
          : '';
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
  };
  let lastStateEvent = null;
  const updateStatus = session.subscribe((event) => {
    if (event.type !== 'state') return;
    lastStateEvent = event;
    paintState(event);
  });
  // A live locale switch re-paints the fixed captions and the last state's
  // readout (I18N.md rule 6); released in both teardown paths below.
  const unsubscribeLocale = subscribeLocale(() => {
    if (!capabilities.pushToTalk) {
      ui.button.setAttribute('aria-label', t('voice.hint.toggleAria'));
      if (ui.helpDetail)
        ui.helpDetail.textContent = t('voice.hint.activateToggle');
    }
    if (lastStateEvent) paintState(lastStateEvent);
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
      unsubscribeLocale();
      updateStatus();
      updateCard?.();
      updatePointer();
      reticle?.destroy();
      card?.destroy();
      runner.dispose?.();
      ui.root.remove();
    },
    { once: true },
  );
  if (session.disposed) {
    ui.button.removeEventListener('click', buttonHandler);
    annotationUnsubscribe?.();
    unsubscribeLocale();
    updateStatus();
    updateCard?.();
    updatePointer();
    reticle?.destroy();
    card?.destroy();
    runner.dispose?.();
    ui.root.remove();
  } else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
