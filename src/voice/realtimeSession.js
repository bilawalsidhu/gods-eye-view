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
  return {
    controller,
    capabilities: { costControls: true, pushToTalk: true },
    start: (settings) => controller.start(settings),
    getStartOptions: () => ({ pushToTalk: Boolean(controller.pushToTalkMode) }),
    stop: (settings) => controller.stop(settings),
    sendText: (text) => controller.sendTextCommand(text),
    sendMapEvent: (event) => controller.notifyMapEvent(event),
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
