/**
 * useIntelHUD — hook providing typed access to the IntelHUD instance from React.
 */
import { useState, useEffect, useCallback } from 'react';

interface IntelHUD {
  setMode(mode: 'on' | 'off' | 'auto'): void;
  getMode(): 'on' | 'off' | 'auto';
  get visible(): boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  setVariant(variant: string): void;
  getVariant(): string;
  attachDataManager(dataManager: unknown): void;
  destroy(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHUD(): IntelHUD | null { return ((window as any).__godsEyeView?.hud) ?? null; }

export function useIntelHUD() {
  const [mode, setModeState] = useState<'on' | 'off' | 'auto'>('auto');
  const [variant, setVariantState] = useState('tactical');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const hud = getHUD();
    if (!hud) return;
    setModeState(hud.getMode());
    setVariantState(hud.getVariant());
    setVisible(hud.visible);
  }, []);

  const setMode = useCallback((m: 'on' | 'off' | 'auto') => {
    const hud = getHUD();
    if (!hud) return;
    hud.setMode(m);
    setModeState(m);
    setVisible(hud.visible);
  }, []);

  const setVariant = useCallback((v: string) => {
    const hud = getHUD();
    if (!hud) return;
    hud.setVariant(v);
    setVariantState(v);
  }, []);

  const toggle = useCallback(() => {
    const hud = getHUD();
    if (!hud) return;
    hud.toggle();
    setModeState(hud.getMode());
    setVisible(hud.visible);
  }, []);

  return { hud: getHUD(), mode, variant, visible, setMode, setVariant, toggle };
}
