import {
  GevRealtimeController,
  shouldIgnoreVoiceButtonClick,
} from './realtimeController.js';
import { createVoiceControl } from './control.js';

/** Bind a supplied action runner and connection controller to the voice controls. */
export function createVoiceCommands({
  runner,
  dataManager,
  annotations = null,
  backend,
  signal,
  debugSink,
  createController = (options) => new GevRealtimeController(options),
}) {
  if (
    window.__gevVoiceCommands &&
    typeof window.__gevVoiceCommands.stop === 'function'
  ) {
    window.__gevVoiceCommands.stop({ removeUi: true });
  }
  const ui = createVoiceControl({ reset: true });
  const radioLayer = dataManager?.layers?.get('radio')?.module || null;
  const controller = createController({
    runner,
    ui,
    radioLayer,
    dataManager,
    backend,
    signal,
    debugSink,
  });
  // Deferred annotation outlines finish AFTER their tool result returned. Feed the
  // final outcome (resolved / failed) into the conversation so the model can honestly
  // confirm — or correct — what it narrated about a boundary it never saw land.
  if (annotations && typeof annotations.onOutlineEvent === 'function') {
    controller.annotationEventUnsubscribe = annotations.onOutlineEvent(
      (evt) => {
        controller.notifyMapEvent({ type: 'map_annotation_outline', ...evt });
      },
    );
  }
  controller.buttonHandler = () => {
    if (shouldIgnoreVoiceButtonClick(controller.spaceKeyHeld)) return;
    if (controller.isActive()) controller.stop();
    else controller.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', controller.buttonHandler);
  if (ui.tierButton) {
    controller.tierHandler = () => controller.toggleVoiceTier();
    ui.tierButton.addEventListener('click', controller.tierHandler);
  }
  controller.syncCostUi();
  controller.bindPushToTalkShortcut();
  window.__gevVoiceCommands = controller;
  return controller;
}
