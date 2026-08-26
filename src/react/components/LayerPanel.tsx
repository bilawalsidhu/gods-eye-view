/**
 * LayerPanel — React component for the data-layer toggle accordion.
 * Replaces the vanilla JS toggle panel with a declarative React implementation.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useDataManager } from '../hooks/useDataManager';

const FEED_STATE_LABELS: Record<string, string> = {
  nominal: 'ON', loading: 'LOADING', degraded: 'DEGRADED',
  stale: 'STALE', fallback: 'FALLBACK', unavailable: 'UNAVAILABLE',
};

function feedState(stats: Record<string, unknown>): string {
  if (stats.loading) return 'loading';
  if (stats.error || stats.lastError) return 'degraded';
  if (stats.retryInSec != null) return 'stale';
  if (!stats.lastUpdate) return 'unavailable';
  return 'nominal';
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function timeAgo(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

function buildMeta(layer: any, dm: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataManager = dm as any;
  const stats = (layer as any).stats ?? {};
  const state = feedState(stats);
  const label = FEED_STATE_LABELS[state] ?? state.toUpperCase();
  const source = stats.source || (layer as any).source || '';
  const { loading, error, lastError, retryInSec, lastUpdate, loadingLabel } = stats;

  if ((layer as any).lifecycleState === 'enabling' || (layer as any).lifecycleState === 'disabling') {
    return `${(layer as any).lifecycleState.toUpperCase()} · ${source}`;
  }
  if ((layer as any).lifecycleUncertain) return `UNCERTAIN · ${source} · lifecycle state requires reconciliation`;
  if (error || lastError) {
    const err = error || lastError;
    return typeof retryInSec === 'number' && retryInSec > 0
      ? `${label} · ${source} · ${err} · retry ${retryInSec}s`
      : `${label} · ${source} · ${err}`;
  }
  const ago = lastUpdate ? timeAgo(lastUpdate) : 'never';
  if (loading) return `${source} · ${(loadingLabel ?? 'loading...').toString().trim()}`;
  return `${label} · ${source} · ${ago}`;
}

interface ChipDesc { id: string; label: string; title?: string; active?: boolean; disabled?: boolean; busy?: boolean; state?: string; params?: Record<string, unknown>; }
interface LegendItem { label: string; count?: number; color?: string; blurb?: string; }

function useRowControls(layerId: string, dm: ReturnType<typeof useDataManager>['dataManager']) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = dm as any;
  if (!d?._rowControlsFor) return { chips: [] as ChipDesc[], legend: [] as LegendItem[] };
  const r = d._rowControlsFor(layerId);
  if (!r) return { chips: [], legend: [] };
  return { chips: (r.chips ?? []) as ChipDesc[], legend: (r.legend ?? []) as LegendItem[] };
}

export function LayerPanel(): React.JSX.Element {
  const { dataManager, layers } = useDataManager();

  const handleToggle = useCallback(async (id: string, currentlyEnabled: boolean) => {
    if (!dataManager) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (dataManager as any).setEnabled(id, !currentlyEnabled, { origin: 'user' });
    } catch (err) { console.warn(`[LayerPanel] toggle error for ${id}:`, err); }
  }, [dataManager]);

  const handleChip = useCallback((id: string, chip: ChipDesc) => {
    if (!dataManager || !chip.params) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataManager as any).setLayerParams(id, chip.params, { origin: 'user' }).catch((e: unknown) => console.warn(`[LayerPanel] chip error:`, e));
  }, [dataManager]);

  if (!dataManager) {
    return <div className="data-toggle-list" aria-label="Data layers">
      <div className="data-toggle-row"><div className="data-toggle-top"><div className="data-toggle-left"><span className="data-name">Loading layers…</span></div></div></div>
    </div>;
  }

  return (
    <div className="data-toggle-list" role="list" aria-label="Data layers">
      {layers
        .filter((l: any) => l.showInTogglePanel !== false)
        .map((layer: any) => (
          <LayerRow key={layer.id} layer={layer} dataManager={dataManager}
            onToggle={handleToggle} onChip={handleChip}
          />
        ))}
    </div>
  );
}

interface LayerRowProps {
  layer: any;
  dataManager: ReturnType<typeof useDataManager>['dataManager'];
  onToggle: (id: string, enabled: boolean) => void;
  onChip: (id: string, chip: ChipDesc) => void;
}

function LayerRow({ layer, dataManager, onToggle, onChip }: LayerRowProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const { chips, legend } = useRowControls(layer.id, dataManager);
  const meta = useMemo(() => buildMeta(layer, dataManager), [layer, dataManager]);
  const count = layer.stats?.count;
  const isEnabled = layer.enabled;

  async function handleToggleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try { await onToggle(layer.id, isEnabled); } finally { setBusy(false); }
  }

  return (
    <div className="data-toggle-row" data-layer-id={layer.id} role="listitem">
      <div className="data-toggle-top">
        <div className="data-toggle-left">
          <span className="data-icon" aria-hidden="true">{layer.icon}</span>
          <span className="data-name">{layer.name}</span>
        </div>
        <div className="data-toggle-right">
          <span className="data-count" aria-label={`${count ?? 'no'} items`}>{count != null ? formatCount(count) : '—'}</span>
          <button className={`data-toggle-btn${isEnabled ? ' active' : ''}`} aria-pressed={isEnabled}
            aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${layer.name}`} aria-busy={busy}
            onClick={handleToggleClick} disabled={busy}>
            <span className="toggle-indicator" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="data-toggle-meta" aria-live="polite">{meta}</div>
      {(chips.length > 0 || legend.length > 0) && (
        <div className="data-toggle-controls" hidden={!isEnabled}>
          {chips.map((chip: ChipDesc) => (
            <button key={chip.id} type="button"
              className={`data-toggle-chip chip-${chip.state || (chip.active ? 'active' : 'idle')}${chip.active ? ' active' : ''}`}
              title={chip.title ?? ''} disabled={Boolean(chip.disabled)}
              aria-pressed={chip.active ? 'true' : 'false'} aria-busy={Boolean(chip.busy)}
              onClick={() => onChip(layer.id, chip)}>
              {chip.label}
            </button>
          ))}
          {legend.map((item: LegendItem, i: number) => (
            <span key={i} className="data-toggle-legend-item" title={item.blurb ?? ''}>
              <span className="data-toggle-legend-swatch" style={{ background: item.color ?? '#888' }} aria-hidden="true" />
              <span>{item.label} {item.count != null ? formatCount(item.count) : ''}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
