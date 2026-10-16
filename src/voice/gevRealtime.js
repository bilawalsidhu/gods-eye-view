import { toFunctionOutput } from '../tools/functions.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
import { cameraPoseKey, createPointerTracker } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { createReferentRegistry } from './referents.js';
import {
  voiceRequestRestrictionResult,
  readVoiceRequestRestriction,
} from './providerIntent.js';
export * from './realtimeController.js';

const ACTION_NAMES = new Set(GEV_ACTION_SCHEMAS.map((schema) => schema.name));

/**
 * Run app actions through `runner` and every other tool the catalog has
 * through the catalog. `loadCatalog` resolves the catalog when first needed.
 */
export function withToolCatalog(runner, loadCatalog) {
  if (typeof loadCatalog !== 'function') return runner;
  const runGevTool = async function runGevTool(name, args, options = {}) {
    const restriction = readVoiceRequestRestriction(options.userTurn);
    if (restriction)
      return voiceRequestRestrictionResult(name, restriction, options);
    if (ACTION_NAMES.has(name)) return runner(name, args, options);
    const checkCurrent = () => {
      options.signal?.throwIfAborted();
      if (options.isCurrent && !options.isCurrent())
        throw new DOMException('Voice query cancelled', 'AbortError');
    };
    checkCurrent();
    const catalog = await loadCatalog();
    checkCurrent();
    // Transcript segments can settle while a lazy catalog loads.
    const loadedRestriction = readVoiceRequestRestriction(options.userTurn);
    if (loadedRestriction)
      return voiceRequestRestrictionResult(name, loadedRestriction, options);
    if (!catalog?.get(name)) return runner(name, args, options);
    const result = await catalog.call(name, args ?? {}, {
      signal: options.signal,
    });
    checkCurrent();
    return toFunctionOutput(name, result);
  };
  runGevTool.resetConversation = (...args) =>
    runner.resetConversation?.(...args);
  runGevTool.dispose = (...args) => runner.dispose?.(...args);
  return runGevTool;
}

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
    runner: withToolCatalog(
      createGevActionRunner({ ...options, deixis }),
      options.toolCatalog,
    ),
  });
  deixis.imageFrame = () => commands.retainedImageFrame?.() || null;
  deixis.onPointerUsed = () => commands.announcePointer?.();
  const lifetime = commands.signal ?? commands.session?.signal;
  if (lifetime?.aborted) pointer?.destroy();
  else
    lifetime?.addEventListener('abort', () => pointer?.destroy(), {
      once: true,
    });
  return commands;
}
