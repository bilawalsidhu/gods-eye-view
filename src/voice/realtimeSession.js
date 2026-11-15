import { createTextChat } from './textChat.js';
import { GevRealtimeController } from './realtimeController.js';

/** Adapt the existing WebRTC implementation to the common voice session. */
export function createRealtimeSession({
  emit,
  runAction,
  createController = (options) => new GevRealtimeController(options),
  ...options
}) {
  const controller = createController({
    ...options,
    actionExecutor: runAction,
    onSessionEvent: emit,
  });
  let textOnly = false;
  const chat = createTextChat({
    ...options,
    provider: 'openai',
    runAction,
    emit: (event) => {
      if (event.type === 'state') controller.status = event.state;
      emit(event);
    },
  });
  const startVoice = (settings) => {
    chat.stop({ preserveStatus: true });
    textOnly = false;
    return controller.start(settings);
  };
  if (controller._input) controller._input.start = startVoice;
  if (controller._radio)
    controller._radio.isActive = () => !textOnly && controller.isActive();
  return {
    controller,
    capabilities: { costControls: true, pushToTalk: true },
    start: (settings) => {
      if (!settings?.textOnly) return startVoice(settings);
      textOnly = true;
      return chat.start();
    },
    getStartOptions: () => ({
      pushToTalk: Boolean(controller.pushToTalkMode),
      ...(textOnly ? { textOnly: true } : {}),
    }),
    stop: (settings) => {
      chat.stop({ ...settings, preserveStatus: true });
      controller.stop(settings);
    },
    // Chat Stop: abort the reply in progress, keep the conversation.
    cancelTurn: () => textOnly && chat.cancelTurn(),
    sendText: (text) =>
      textOnly ? chat.sendText(text) : controller.sendTextCommand(text),
    sendMapEvent: (event) =>
      textOnly ? chat.sendMapEvent(event) : controller.notifyMapEvent(event),
    ignoreButtonClick: () => Boolean(controller.spaceKeyHeld),
    bindControls() {
      // Kept as the remover; a full stop releases it. The cost readout and
      // tier toggle are worded again in a new locale.
      const offTier = controller.ui.on('tier', () =>
        controller.toggleVoiceTier(),
      );
      const offLocale = controller.ui.on('locale', () =>
        controller.syncCostUi(),
      );
      controller.tierHandler = () => {
        offTier();
        offLocale();
      };
      controller.syncCostUi();
      controller.bindPushToTalkShortcut();
    },
  };
}
