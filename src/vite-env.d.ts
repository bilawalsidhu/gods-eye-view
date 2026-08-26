/// <reference types="vite/client" />

// Global exposed by main.js after viewer init
interface Window {
  __godsEyeView?: {
    viewer?: unknown;
    hud?: unknown;
    styleManager?: unknown;
    dataManager?: unknown;
    sceneDirector?: unknown;
    mapStackController?: unknown;
    annotations?: unknown;
    weatherEffects?: unknown;
    cockpitCloudEffects?: unknown;
    voiceCommands?: unknown;
    getRenderGovernorDiagnostics?: () => unknown;
    requestRender?: () => void;
  };
  __GOOGLE_MAPS_API_KEY__?: string;
}

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY: string;
  readonly VITE_CESIUM_ION_TOKEN: string;
  readonly VITE_API_BASE_URL: string;
  readonly VITE_AIS_LIVE_API_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
