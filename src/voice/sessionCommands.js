import { nextTick } from 'vue';
import { bindAssistantPanelLayout, bindLayoutDock } from './panelLayout.js';
import { bindChatControl } from './chatControl.js';
import { bindVoiceMiniPreview } from './voiceMiniPreview.js';
import { createVoiceControl, voiceStatusLabel } from './control.js';
import { createVoiceSession, isStoppable } from './session.js';
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
  // Chat's Settings, carried across a provider switch.
  presentation = null,
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
    // A typed chat session is not the microphone.
    ui.update('button', {
      pressed: session.isActive() && !adapter.getStartOptions?.().textOnly,
    });
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
  // Typed chat turns belong to the chat panel, not the voice card or panel.
  const voicePresentation = (handle) => (event) => {
    if (event.type !== 'state' && adapter.getStartOptions?.().textOnly) return;
    handle(event);
  };
  const updatePanel = panelMount
    ? session.subscribe(voicePresentation(panelMount.handle))
    : null;
  const updateCard =
    card && !panelMount
      ? session.subscribe(voicePresentation((event) => card.handle(event)))
      : null;
  controls.voiceCard = card;
  if (panelMount) {
    controls.voicePanel = panelMount.panel;
    // An explicit, successful show hands the frame from chat to the voice
    // panel, which chat's open state hides. Closing chat keeps its typed
    // session, running turn and messages; reopening chat restores them.
    // Focus held in chat (its composer, or chat Settings' Back) would be
    // left on a hidden control, so it moves to the panel's view, as the
    // panel's own tabs do; focus anywhere else stays where it is.
    controls.captureVoicePanelOperation = () => {
      const operation = panelMount.captureOperation();
      return {
        ...operation,
        show(view, open = true) {
          const focused = globalThis.document?.activeElement;
          const inChat =
            Boolean(focused) &&
            (ui.element('chatPanel')?.contains?.(focused) ||
              focused === ui.element('chatBack'));
          const result = operation.show(view, open);
          if (!open || !result.ok) return result;
          chat?.close();
          if (inChat)
            void ui.focus(
              result.view === 'settings'
                ? ['settingsTab', 'voiceBack', 'settingsClose']
                : ['previewTab', 'settingsTab', 'settingsClose'],
            );
          return result;
        },
      };
    };
    controls.getVoicePanelState = panelMount.snapshot;
    controls.getVoicePreferences = panelHost.snapshot;
  }
  // Point-and-ask: the reticle follows turn events; pointer and referents are
  // session-scoped, so a session that ends forgets both.
  const reticle = pointer ? createReticle(pointer) : null;
  const updatePointer = session.subscribe((event) => {
    reticle?.handle(event);
    // A failed typed turn ends only that reply; its conversation continues.
    if (
      event.type === 'state' &&
      (event.state === 'idle' ||
        (event.state === 'error' && !adapter.getStartOptions?.().textOnly))
    ) {
      pointer?.clear();
      referents?.clear();
      // Conversation memory ("those", "the last answer") ends with the
      // session; area handles live for the page.
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
  const chat = panelMount
    ? bindChatControl({
        ui,
        session,
        dataManager,
        onOpen: () => panelMount?.panel.close(),
      })
    : null;
  chat?.restorePresentation(presentation);
  controls.chatPresentation = () => chat?.presentation() ?? null;
  function minimizeVoicePanel() {
    const panel = ui.element('voicePanel');
    const holdsFocus = panel?.contains?.(globalThis.document?.activeElement);
    ui.update('voicePanel', { minimized: true });
    // Keep focus on the bar's expand button, not the mic (Space there would
    // end voice), without a keyboard ring.
    if (holdsFocus)
      void nextTick(() =>
        panel
          ?.querySelector?.('[data-layout-minimize]')
          ?.focus?.({ focusVisible: false }),
      );
  }
  const layouts = panelMount
    ? [
        bindLayoutDock(ui),
        bindAssistantPanelLayout({
          ui,
          name: 'chatPanel',
          minimize: () => chat?.minimize({ focus: false }),
          restore: () => chat?.restore({ focus: false }),
        }),
        bindAssistantPanelLayout({
          ui,
          name: 'voicePanel',
          minimize: minimizeVoicePanel,
          restore: () => ui.update('voicePanel', { minimized: false }),
        }),
        ui.on('voice-minimize', () => {
          if (ui.state.voicePanel.minimized)
            ui.update('voicePanel', { minimized: false });
          else minimizeVoicePanel();
        }),
      ]
    : [];
  const unbindMiniPreview = panelMount
    ? bindVoiceMiniPreview({ ui, session })
    : null;
  const startVoice = () => {
    if (panelMount?.panel.snapshot().previewEnabled)
      panelMount.panel.select('preview');
    void session.start({ pushToTalk: false });
  };
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    chat?.close();
    if (session.isActive() && adapter.getStartOptions?.().textOnly) {
      session.stop();
      startVoice();
    } else if (session.isActive()) {
      const ticket = panelMount?.stopTicket();
      session.stop();
      panelMount?.closeAfterStop(ticket);
    } else startVoice();
  };
  const offButton = ui.on('button', buttonHandler);
  // The panel's close turns voice off, as chat's close ends the chat. A typed
  // session belongs to chat, which handles its own close.
  const offClose = ui.on('settings-close', () => {
    // A voice error the user closes is over too; stopping returns to idle.
    if (!isStoppable(session) || adapter.getStartOptions?.().textOnly) return;
    const ticket = panelMount?.stopTicket();
    session.stop();
    panelMount?.closeAfterStop(ticket);
  });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    offButton();
    offClose();
    offProvider?.();
    for (const off of layouts) off();
    unbindMiniPreview?.();
    chat?.destroy();
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
