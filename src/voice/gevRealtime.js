import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
import { cameraPoseKey, createPointerTracker } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { createReferentRegistry } from './referents.js';
export * from './realtimeController.js';

/** Compose the standalone action runner with the voice controls. */
export function initGevVoiceCommands(options) {
  const canvas = options.viewer?.scene?.canvas || null;
  const cameraKey = () => cameraPoseKey(options.viewer);
  // Point-and-ask: the tracker and referents are shared by the runner (which
  // resolves 'pointer' and referent:n) and the controls (which snapshot the
  // pointer at turn start and clear both when the session ends).
  const pointer = canvas
    ? createPointerTracker({
        element: canvas,
        cameraKey,
        pick: createPointerPicker({
          viewer: options.viewer,
          dataManager: options.dataManager,
        }),
      })
    : null;
  const referents = createReferentRegistry();
  // The controller exists only after the runner, so its hooks bind late.
  const deixis = { pointer, referents, cameraKey };
  const commands = createVoiceCommands({
    ...options,
    pointer,
    referents,
    runner: createGevActionRunner({ ...options, deixis }),
  });
  deixis.imageFrame = () => commands.retainedImageFrame?.() || null;
  deixis.onPointerUsed = () => commands.announcePointer?.();
  commands.session?.signal?.addEventListener(
    'abort',
    () => pointer?.destroy(),
    { once: true },
  );
  return commands;
}
