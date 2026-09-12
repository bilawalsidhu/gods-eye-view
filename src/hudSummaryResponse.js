import {
  feedProvenanceEnvelope,
  layerSnapshots,
} from './data/layerSnapshot.js';

export const HUD_SUMMARY_UNCONFIGURED_CODE = 'OPENAI_NOT_CONFIGURED';

/**
 * Describe the optional HUD summary capability without turning a deliberately
 * keyless boot into an HTTP failure.
 *
 * @param {unknown} apiKey - Candidate server-side OpenAI credential.
 * @returns {{ statusCode: 200, payload: { configured: false, code: string, error: null, summary: null } }|null}
 *   A graceful unconfigured response, or null when the provider is configured.
 */
export function keylessHudSummaryResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: {
      configured: false,
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
      error: null,
      summary: null,
    },
  };
}

/** Return true only for the deliberate, successful no-key capability response. */
export function isHudSummaryUnconfigured(status, data) {
  const keys = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data)
    : [];
  return keys.length === 4
    && status === 200
    && data?.configured === false
    && data?.code === HUD_SUMMARY_UNCONFIGURED_CODE
    && data?.error === null
    && data?.summary === null;
}

/**
 * HUD summary model instructions. The five-word line may only describe
 * supplied labels, and must carry feed-state when any enabled layer is not
 * nominal.
 */
export const HUD_SUMMARY_INSTRUCTIONS = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, enabled-layer labels, and feedProvenance.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'If any enabled layer is not nominal, the five words MUST include that feedState token (STALE, DEGRADED, FALLBACK, LOADING, or UNAVAILABLE) and must not present the view as live.',
  'Do not infer from coordinates or invent a place or feed state.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

/**
 * Stamp HUD summary context with the same layer snapshots voice tools use.
 * @param {Array<object>} [layers] `DataLayerManager.getAll()` rows.
 * @param {{ now?: number }} [options]
 * @returns {{
 *   enabledLayerLabels: string[],
 *   enabledLayers: Array<{id: string|null, name: string|null, feedState: string, source: string|null, count: number}>,
 *   feedProvenance: object,
 * }}
 */
export function hudSummaryLayerContext(layers = [], options) {
  const snapshots = layerSnapshots(layers, options).filter((s) => s.enabled);
  const envelope = feedProvenanceEnvelope(snapshots, options);
  return {
    enabledLayerLabels: snapshots.map((s) => s.name).filter(Boolean),
    enabledLayers: snapshots.map((s) => ({
      id: s.id,
      name: s.name,
      feedState: s.feedState,
      source: s.source,
      count: s.count,
    })),
    feedProvenance: envelope,
  };
}

/**
 * Deterministic telemetry suffix when an enabled feed is not nominal.
 * @param {Array<object>} [layers]
 * @param {{ now?: number }} [options]
 * @returns {string|null}
 */
export function hudTelemetryProvenanceTag(layers = [], options) {
  const snapshots = layerSnapshots(layers, options).filter((s) => s.enabled);
  const envelope = feedProvenanceEnvelope(snapshots, options);
  if (!envelope.overall || envelope.overall === 'nominal') return null;
  const names = envelope.layers
    .filter((s) => s.feedState && s.feedState !== 'nominal' && s.feedState !== 'off')
    .map((s) => String(s.name || s.id || 'LAYER').toUpperCase())
    .slice(0, 2);
  return `${envelope.overall.toUpperCase()}${names.length ? ` ${names.join('/')}` : ''}`;
}
