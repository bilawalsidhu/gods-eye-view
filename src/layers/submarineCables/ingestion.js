import { msg, t } from '../../i18n/index.js';
import { findFrame } from '../../render/rendererOf.js';
import { normalizeFeatures } from './geometry.js';

export function createIngestion({ state, parts, source }) {
  async function load(viewer) {
    if (state._loading || state._loaded) return;

    state._loading = true;
    state._error = null;
    state._loadingLabel = t('loading...');
    // Ownership token (the militaryAwareness activationId pattern): a
    // disable/abort followed by a fresh enable starts a NEWER load while this
    // one is still settling. The stale load must bail after every await and
    // must never touch shared lifecycle state or the sets it no longer
    // owns — clearing `_loading`/`_abort` for the successor is how duplicate
    // loads got drawn.
    const generation = ++state._loadGeneration;
    const abort = new AbortController();
    state._abort = abort;
    const owns = () =>
      generation === state._loadGeneration && !abort.signal.aborted;

    try {
      let cableJson = state._cachedCableJson;
      let landingJson = state._cachedLandingJson;
      if (!cableJson || !landingJson) {
        ({ cables: cableJson, landingPoints: landingJson } = await source.fetch(
          abort.signal,
        ));
        if (!owns()) return;
        if (
          !Array.isArray(cableJson?.features) ||
          !Array.isArray(landingJson?.features)
        ) {
          throw new TypeError(
            'A cable source must return cables and landingPoints GeoJSON collections',
          );
        }
        state._cachedCableJson = cableJson;
        state._cachedLandingJson = landingJson;
      }

      const cableFeatures = normalizeFeatures(cableJson, 'cable');
      const landingFeatures = normalizeFeatures(landingJson, 'landing');

      // Await-free from here: this load still owns the lifecycle, and the
      // items go into the layer's own sets in one pass.
      parts.rendering.attach(viewer);
      parts.rendering.drawFeatures(cableFeatures, landingFeatures);

      state._count = cableFeatures.length + landingFeatures.length;
      state._loaded = true;
      state._lastUpdate = Date.now();
      state._loadingLabel = '';
      parts.rendering.updateVisibility();
      state._referenceSweepGate.markDirty();
      findFrame(viewer)?.requestRender('submarine-cables');
    } catch (error) {
      // A stale or aborted load reports nothing: its failure belongs to a
      // lifecycle the user already left.
      if (owns() && error?.name !== 'AbortError') {
        state._error = error?.message || msg('TeleGeography load failed');
        console.warn(
          '[Data:telegeography-submarine-cables]',
          state._error,
          error,
        );
      }
    } finally {
      // Only the OWNING load may clear the shared lifecycle. A stale load
      // clearing `_loading`/`_abort` would hand a later enable/update a
      // duplicate load while the real one is still in flight.
      if (generation === state._loadGeneration) {
        state._loading = false;
        if (state._abort === abort) state._abort = null;
      }
    }
  }
  return { load };
}
