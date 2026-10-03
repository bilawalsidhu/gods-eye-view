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
    capabilities: {
      costControls: true,
      pushToTalk: true,
      advisoryLimit:
        'OpenAI Realtime sessions can last up to 60 minutes. rate_limits.updated reports quota, and server idle_timeout_ms prompts rather than closes the session.',
    },
    start: (settings) => controller.start(settings),
    stop: (settings) => controller.stop(settings),
    sendText: (text) => controller.sendTextCommand(text),
    sendMapEvent: (event) => controller.notifyMapEvent(event),
    ignoreButtonClick: () => Boolean(controller.spaceKeyHeld),
    bindControls() {
      if (controller.ui.tierButton) {
        controller.tierHandler = () => controller.toggleVoiceTier();
        controller.ui.tierButton.addEventListener(
          'click',
          controller.tierHandler,
        );
      }
      controller.syncCostUi();
      controller.bindPushToTalkShortcut();
    },
  };
}
