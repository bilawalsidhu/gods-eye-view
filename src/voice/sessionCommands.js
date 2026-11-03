import { createVoiceControl, voiceStatusLabel } from './control.js';
import { createVoiceSession } from './session.js';
import { VoiceCardControls } from './voiceCard.js';
import { PointerReticle } from './pointerReticle.js';
import { VOICE_PROVIDERS } from './providerCapabilities.js';
import { t } from '../i18n/index.js';

function createDefaultReticle(pointer) {
  const element = pointer?.element;
  if (!element?.ownerDocument) return null;
  return new PointerReticle({
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
  panelHost = null,
  nativePanelProvider = null,
}) {
  if (resetExisting) window.__gevVoiceCommands?.stop?.({ removeUi: true });
  const ui = createControl(panelHost ? { panel: true } : {});
  let actionObserver;
  let panelMount;
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter: (hooks) => {
      if (panelHost) actionObserver = panelHost.observeActions(hooks);
      return createSession({
        ...hooks,
        ...(actionObserver ? { runAction: actionObserver.runAction } : {}),
        runner,
        ui,
        dataManager,
        backend,
        debugSink,
        createController,
        pointer,
        radioLayer: dataManager?.layers?.get('radio')?.module || null,
      });
    },
  });
  const adapter = session.adapter;
  const capabilities = adapter.capabilities || {};
  const offProvider = onProviderChange
    ? ui.on('provider-change', (value) => onProviderChange(value))
    : null;
  if (onProviderChange) {
    ui.update('provider', {
      ...(supportedProviders && {
        options: supportedProviders.map((name) => ({
          value: name,
          label: VOICE_PROVIDERS[name].label,
        })),
      }),
      value: provider,
      title: () =>
        [
          t('Changing provider reconnects voice if it is on.'),
          capabilities.advisoryLimit,
        ]
          .filter(Boolean)
          .join(' '),
    });
    ui.update('root', { provider });
  }
  const hasProviderChoice = Boolean(
    onProviderChange && supportedProviders?.length > 1,
  );
  ui.update('provider', { hidden: !hasProviderChoice });
  ui.update('root', { providerChoice: String(hasProviderChoice) });
  ui.update('tier', { hidden: !capabilities.costControls });
  ui.update('cost', { hidden: !capabilities.costControls });
  if (!capabilities.pushToTalk) {
    ui.update('button', { label: () => t('Toggle voice control') });
    ui.update('help', { text: () => t('Activate to toggle voice') });
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  controls.ui = ui;
  const updateStatus = session.subscribe((event) => {
    if (event.type !== 'state') return;
    ui.update('root', {
      status: event.state,
      ...(event.state === 'error' && { errorDismissed: false }),
    });
    // States are machine values; only the label is translated.
    ui.update('status', { text: () => voiceStatusLabel(event.state) });
    // The portable session reports 'Voice off' in English: show the idle
    // label instead. Other details are provider messages, shown as they come.
    const idle = event.state === 'idle';
    const detail = event.detail === 'Voice off' ? '' : event.detail;
    ui.update('detail', {
      text: () => detail || (idle ? t('Voice off') : t('Voice active')),
    });
    ui.update('button', { pressed: session.isActive() });
    ui.update('error', {
      text: () =>
        event.state === 'error'
          ? event.detail || t('Voice could not be started.')
          : '',
    });
  });
  // Captions, plan and result card nested in the control; it only reads
  // provider-neutral session events.
  const card = createCard({
    ui,
    ...(panelHost ? { onRender: () => panelMount?.panel.sync() } : {}),
  });
  panelMount = panelHost?.mount({
    ui,
    card,
    session,
    observer: actionObserver,
    nativeProvider: nativePanelProvider,
  });
  const updatePanel = panelMount ? session.subscribe(panelMount.handle) : null;
  const updateCard =
    card && !panelMount
      ? session.subscribe((event) => card.handle(event))
      : null;
  controls.voiceCard = card;
  if (panelMount) {
    controls.voicePanel = panelMount.panel;
    controls.captureVoicePanelOperation = panelMount.captureOperation;
    controls.getVoicePanelState = panelMount.snapshot;
    controls.getVoicePreferences = panelHost.snapshot;
  }
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
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    if (session.isActive()) {
      const ticket = panelMount?.stopTicket();
      session.stop();
      panelMount?.closeAfterStop(ticket);
    } else void session.start({ pushToTalk: false });
  };
  const offButton = ui.on('button', buttonHandler);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    offButton();
    offProvider?.();
    annotationUnsubscribe?.();
    updateStatus();
    updateCard?.();
    updatePanel?.();
    panelMount?.destroy();
    actionObserver?.dispose();
    updatePointer();
    forwardEvents?.();
    reticle?.destroy();
    card?.destroy();
    if (disposeRunner) runner.dispose?.();
    ui.remove();
  };
  session.signal.addEventListener('abort', cleanup, { once: true });
  if (session.disposed) cleanup();
  else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
