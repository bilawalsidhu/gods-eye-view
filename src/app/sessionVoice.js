import { createSceneVoice } from '../voice/gevRealtime.js';

/**
 * Attach the page's voice to this engine's scene. With a layer session the
 * voice is created once, for the page lifetime, and every engine attachment
 * only gives it the scene (runner, pointer canvas, annotation events): an
 * active voice session keeps its microphone and transport through a switch.
 * Without one (a host that never switches) the voice lives with this
 * application. Returns the voice commands.
 */
export function attachSessionVoice({
  layerSession = null,
  voice = {},
  operations,
  placeSearch,
  dataManager,
  scene,
  signal,
  defer,
}) {
  const options = {
    ...voice,
    floorServices: operations.surface?.groundFloor,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
    placeSearch,
    dataManager,
  };
  let sceneVoice;
  if (layerSession) {
    sceneVoice = layerSession.voice ??= createSceneVoice({
      ...options,
      signal: layerSession.lifetime.signal,
      isSwitching: () => layerSession.switching?.() === true,
    });
  } else {
    sceneVoice = createSceneVoice({ ...options, signal });
    defer(() => {
      sceneVoice.commands.stop({ removeUi: true });
      if (window.__gevVoiceCommands === sceneVoice.commands)
        delete window.__gevVoiceCommands;
    });
  }
  sceneVoice.attachScene({ ...scene, dataManager });
  defer(() => sceneVoice.detachScene());
  return sceneVoice.commands;
}
