import { startApplicationChrome } from '../app/startupChrome.js';
import { initKeySetup } from '../keySetup.js';
import { initAiCommandCenter } from '../ui/aiCommandCenter.js';

export function startStandaloneChrome(options) {
  try {
    initAiCommandCenter({
      getGlobeContext: () => {
        const gev = globalThis.window?.__godsEyeView;
        if (!gev) return null;
        const context = {};
        try {
          if (gev.dataManager?.contextStore) {
            Object.assign(
              context,
              gev.dataManager.contextStore.getSnapshot?.() || {},
            );
          }
        } catch {
          // Context is optional
        }
        try {
          const camera = gev.viewer?.camera;
          const CesiumRef = globalThis.window?.Cesium;
          if (camera && CesiumRef) {
            const carto = CesiumRef.Cartographic.fromCartesian(
              camera.positionWC,
            );
            context.camera = {
              lat: Number(CesiumRef.Math.toDegrees(carto.latitude).toFixed(4)),
              lon: Number(CesiumRef.Math.toDegrees(carto.longitude).toFixed(4)),
              altMeters: Math.round(carto.height),
              headingDeg: Math.round(
                CesiumRef.Math.toDegrees(camera.heading || 0),
              ),
              pitchDeg: Math.round(CesiumRef.Math.toDegrees(camera.pitch || 0)),
              rollDeg: Math.round(CesiumRef.Math.toDegrees(camera.roll || 0)),
            };
          }
        } catch {
          // Camera reading is optional
        }
        try {
          const tracked = gev.viewer?.trackedEntity;
          if (tracked) {
            context.trackedEntity = {
              id: tracked.id || null,
              name: tracked.name || null,
            };
          }
        } catch {
          // Tracked entity reading is optional
        }
        return context;
      },
      executeGlobeAction: async (name, args) => {
        const gev = globalThis.window?.__godsEyeView;
        const runner = gev?.runner || gev?.voiceCommands?.runner;
        if (typeof runner === 'function') {
          return await runner(name, args);
        }
        return null;
      },
    });
  } catch {
    // Graceful fallback in non-browser environments
  }
  return startApplicationChrome({
    initializeSettings: initKeySetup,
    ...options,
  });
}
