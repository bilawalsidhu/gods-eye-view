/**
 * useDataManager — typed hook providing access to the DataLayerManager from React.
 */
import { useState, useEffect } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDM(): any { return ((window as any).__godsEyeView?.dataManager) ?? null; }

export function useDataManager() {
  const [layers, setLayers] = useState<ReturnType<NonNullable<ReturnType<typeof getDM>>['getAll']>>([]);

  useEffect(() => {
    const dm = getDM();
    if (dm) setLayers(dm.getAll());
    const id = setInterval(() => {
      const dm2 = getDM();
      if (dm2) setLayers(dm2.getAll());
    }, 800);
    return () => clearInterval(id);
  }, []);

  return { dataManager: getDM(), layers };
}
