import { toFunctionOutput } from '../tools/functions.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
import { cameraPoseKey, createPointerTracker } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { createReferentRegistry } from './referents.js';
import { createSceneRunner } from './sceneRunner.js';
import { createAreaStore } from '../data/areaStore.js';
export * from './realtimeController.js';

const ACTION_NAMES = new Set(GEV_ACTION_SCHEMAS.map((schema) => schema.name));

/**
 * Run app actions through `runner` and every other tool the catalog has
 * through the catalog. `loadCatalog` resolves the catalog when first needed.
 */
export function withToolCatalog(runner, loadCatalog) {
  if (typeof loadCatalog !== 'function') return runner;
  const runGevTool = async function runGevTool(name, args, options = {}) {
    if (ACTION_NAMES.has(name)) return runner(name, args, options);
    const catalog = await loadCatalog();
    if (!catalog?.get(name)) return runner(name, args, options);
    const result = await catalog.call(name, args ?? {}, {
      signal: options.signal,
    });
    return toFunctionOutput(name, result);
  };
  runGevTool.resetConversation = (...args) =>
    runner.resetConversation?.(...args);
  runGevTool.dispose = (...args) => runner.dispose?.(...args);
  return runGevTool;
}

/**
 * Voice for a page whose globe engine can change while it runs: the
 * microphone, transport, controls and conversation belong to the page
 * session; the action runner, the pointer's canvas and picker and the
 * annotation events belong to one engine attachment (`attachScene`), and a
 * switch only replaces those. Returns `{ commands, runner, attachScene,
 * detachScene }`; `commands` is the voice controls' command handle.
 *
 * `isSwitching()` tells the runner that the page has started a switch, so a
 * call made before the outgoing scene detaches waits for the next one too.
 * `createRunner` replaces createGevActionRunner (tests).
 */
export function createSceneVoice(options) {
  const scene = { engine: null };
  let areaAnnotations = null;
  const areaStore =
    options.areaOptions?.store ??
    createAreaStore({
      isPinned: (areaId) =>
        areaAnnotations?.list?.().some((anno) => anno?.areaId === areaId) ??
        false,
    });
  const cameraKey = () => cameraPoseKey(scene.engine);
  let pick = null;
  // Point-and-ask: the tracker and referents are shared by the runner (which
  // resolves 'pointer' and referent:n) and the controls (which snapshot the
  // pointer at turn start and clear both when the session ends).
  const pointer = createPointerTracker({
    element: null,
    cameraKey,
    pick: (x, y) => pick?.(x, y) ?? null,
  });
  const referents = createReferentRegistry();
  // The controller exists only after the runner, so its hooks bind late.
  const deixis = { pointer, referents, cameraKey };
  // The analyst's follow-up memory and the layer enable times outlive one
  // engine's runner.
  const analystMemory = { lastResult: null };
  const layerEnabledAt = new Map();
  let commands;
  const runner = createSceneRunner({
    isSwitching: options.isSwitching,
    switchWaitMs: options.switchWaitMs,
    build: (attached) =>
      withToolCatalog(
        (options.createRunner ?? createGevActionRunner)({
          ...options,
          ...attached,
          deixis,
          analystMemory,
          layerEnabledAt,
          areaOptions: { ...options.areaOptions, store: areaStore },
          readVoicePanelOperation: () =>
            commands?.captureVoicePanelOperation?.(),
        }),
        options.toolCatalog,
      ),
  });
  const resetConversation = runner.resetConversation;
  runner.resetConversation = () => {
    analystMemory.lastResult = null;
    resetConversation();
  };
  // Annotation outline events of whichever engine is attached.
  const outlineListeners = new Set();
  let offOutline = null;
  const annotations = {
    onOutlineEvent(listener) {
      outlineListeners.add(listener);
      return () => outlineListeners.delete(listener);
    },
  };
  // The panel reads the cockpit of the attached shell.
  let shell = null;
  const styleManager = {
    getCockpitState: () => shell?.getCockpitState?.() ?? null,
  };
  commands = createVoiceCommands({
    ...options,
    styleManager,
    annotations,
    pointer,
    referents,
    runner,
  });
  deixis.imageFrame = () => commands.retainedImageFrame?.() || null;
  deixis.onPointerUsed = () => commands.announcePointer?.();
  const lifetime = commands.signal ?? commands.session?.signal;
  let attachedOnce = false;
  const detachScene = () => {
    runner.detach();
    offOutline?.();
    offOutline = null;
    pointer.setElement(null);
    pick = null;
    scene.engine = null;
    shell = null;
  };
  lifetime?.addEventListener(
    'abort',
    () => {
      detachScene();
      pointer.destroy();
    },
    { once: true },
  );
  if (lifetime?.aborted) pointer.destroy();
  return {
    commands,
    runner,
    /**
     * Attach the voice to one engine: `{ viewer, engine, styleManager,
     * dataManager, sceneDirector, annotations }` (viewer and annotations
     * null on an engine without them).
     */
    attachScene(attached) {
      if (lifetime?.aborted) return;
      detachScene();
      const engine = attached.engine ?? null;
      areaAnnotations = attached.annotations ?? null;
      scene.engine = engine;
      shell = attached.styleManager ?? null;
      pick = createPointerPicker({
        engine,
        dataManager: attached.dataManager ?? options.dataManager,
      });
      pointer.setElement(engine?.host.canvas || null);
      offOutline =
        attached.annotations?.onOutlineEvent?.((event) => {
          for (const listener of [...outlineListeners]) listener(event);
        }) ?? null;
      runner.attach({ ...attached, engine });
      // A session that outlived the switch hears which globe it now drives.
      if (attachedOnce && commands.isActive?.()) {
        const event = { type: 'engine-changed', engine: engine?.kind ?? null };
        if (typeof commands.notifyMapEvent === 'function')
          commands.notifyMapEvent(event);
        else commands.session?.sendMapEvent?.(event);
      }
      attachedOnce = true;
    },
    detachScene,
  };
}
