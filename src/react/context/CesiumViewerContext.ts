/**
 * CesiumViewerContext — React context providing typed access to the Cesium viewer.
 *
 * The viewer and IntelHUD are created by src/main.js during app initialization.
 */
import { createContext, useContext } from 'react';

export interface CesiumViewerContextValue {
  viewer: unknown;
  hud: unknown;
  isReady: boolean;
}

export const CesiumViewerContext = createContext<CesiumViewerContextValue>({
  viewer: null,
  hud: null,
  isReady: false,
});

export function useCesiumViewerContext(): CesiumViewerContextValue {
  return useContext(CesiumViewerContext);
}
