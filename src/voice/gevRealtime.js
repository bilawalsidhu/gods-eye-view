import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
import { createLocalWebSessionLoader } from './local/localWebProvider.js';
import { cameraPoseKey, createPointerTracker } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { createReferentRegistry } from './referents.js';
import { readVoiceEngine, writeVoiceEngine } from './voiceEngine.js';
export * from './realtimeController.js';

/**
 * Compose the standalone action runner with the voice controls on the
 * chosen engine (Cloud or On-device). Choosing the other engine in the
 * voice control persists it and rebuilds voice on that engine; `onReplace`
 * receives the new controls.
 */
export function initGevVoiceCommands(
  options,
  {
    engine = readVoiceEngine(),
    onReplace = options.onReplace,
    openTray = false,
  } = {},
) {
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
  // The on-device provider loads only when that engine is chosen.
  const local =
    engine === 'on-device'
      ? {
          createSession: (hooks) =>
            createLocalWebSessionLoader({ ...hooks, viewer: options.viewer }),
        }
      : {};
  let replaced = false;
  const commands = createVoiceCommands({
    ...options,
    ...local,
    pointer,
    referents,
    runner: createGevActionRunner({ ...options, deixis }),
    engineChoice: {
      engine,
      openTray,
      select(next) {
        if (replaced || next === engine || !writeVoiceEngine(next)) return;
        replaced = true;
        // The new control opens its tray so the choice's settings show.
        onReplace?.(
          initGevVoiceCommands(options, {
            engine: next,
            onReplace,
            openTray: true,
          }),
        );
      },
    },
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
