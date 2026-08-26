/**
 * App — top-level React shell for God's Eye View.
 *
 * Phase 6.1: Wrapped in ErrorBoundary to catch render errors.
 * Phase 5.3: useVoiceCommands and useSceneDirector hooks provide typed access
 * to the vanilla voice and scene systems. Phase 5.2 LayerPanel replaces the
 * vanilla toggle panel. IntelHUD owns its own DOM.
 */
import React, { useState } from 'react';
import { CesiumViewerContext } from './context/CesiumViewerContext';
import { LayerPanel } from './components/LayerPanel';
import { HUDPanel } from './components/HUDPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useVoiceCommands } from './hooks/useVoiceCommands';
import { useSceneDirector } from './hooks/useSceneDirector';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getViewerValue() {
  const gev = (window as any).__godsEyeView;
  return { viewer: gev?.viewer ?? null, hud: gev?.hud ?? null, isReady: Boolean(gev?.viewer) };
}

/** Confirms React integration is live — shown as a fixed overlay. */
function DevIndicator(): React.JSX.Element {
  const { voiceCommands } = useVoiceCommands();
  const { sceneDirector } = useSceneDirector();
  return (
    <div style={{
      position: 'fixed', bottom: '80px', right: '16px',
      background: 'rgba(0,220,100,0.15)', border: '1px solid rgba(0,220,100,0.4)',
      borderRadius: '6px', padding: '6px 12px',
      fontFamily: 'JetBrains Mono, monospace', fontSize: '11px',
      color: 'rgba(0,220,100,0.9)', pointerEvents: 'none', userSelect: 'none', zIndex: 9999,
    }}>
      React ✓ · Voice:{voiceCommands ? '✓' : '✗'} · Scene:{sceneDirector ? '✓' : '✗'}
    </div>
  );
}

function AppInner(): React.JSX.Element {
  const [viewerValue] = useState(getViewerValue);
  return (
    <CesiumViewerContext.Provider value={viewerValue}>
      <HUDPanel />
      <LayerPanel />
      <DevIndicator />
    </CesiumViewerContext.Provider>
  );
}

export function App(): React.JSX.Element {
  return (
    <ErrorBoundary name="GEV-App">
      <AppInner />
    </ErrorBoundary>
  );
}
