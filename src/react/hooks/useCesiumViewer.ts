/**
 * useCesiumViewer — typed hook to access the Cesium viewer from React components.
 */
import { useContext } from 'react';
import { CesiumViewerContext } from '../context/CesiumViewerContext';

export function useCesiumViewer() {
  const ctx = useContext(CesiumViewerContext);
  return { viewer: ctx.viewer, hud: ctx.hud, isReady: ctx.isReady };
}
