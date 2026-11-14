import { msg, t } from '../../i18n/index.js';
import {
  featureLabel,
  featureParts,
  featureReference,
  normalizeFeatures,
} from './geometry.js';
import * as Cesium from 'cesium';

const toCartesian = ([lon, lat, height]) =>
  Cesium.Cartesian3.fromDegrees(lon, lat, height ?? 0);

export function createIngestion({ state, parts, source }) {
  /**
   * Turn the two feature collections into what rendering draws. Every part
   * of a multipart feature is its own line or marker with its own pick
   * record, all sharing the feature's reference; a feature gets one
   * reference stem however many parts it has.
   */
  function describeScene(cableFeatures, landingFeatures) {
    const lines = [];
    const markers = [];
    const references = [];
    const add = (features, kind, style) => {
      for (const feature of features) {
        const reference = featureReference(feature);
        if (!reference) continue;
        const label = featureLabel(feature);
        const base = Cesium.Cartesian3.fromDegrees(
          reference.lon,
          reference.lat,
          0,
        );
        const drawn = featureParts(feature);
        const pick = () =>
          parts.interaction.registerPick({ kind, reference, label });
        for (const line of drawn.lines)
          lines.push({
            info: pick(),
            base,
            positions: line.map(toCartesian),
            color: style.lineColor(feature),
            width: style.lineWidth,
          });
        for (const point of drawn.points)
          markers.push({
            info: pick(),
            base,
            position: toCartesian(point),
            hasHeight: point.length > 2,
            color: style.color,
          });
        references.push({
          reference,
          label,
          kind,
          color: style.color,
          feature,
        });
      }
    };
    add(cableFeatures, 'cable', {
      color: state.cableColor,
      lineWidth: 2.5,
      lineColor: (feature) => {
        const css = feature?.properties?.color;
        const color = css && Cesium.Color.fromCssColorString(String(css));
        return (color || state.cableColor).withAlpha(0.92);
      },
    });
    const landingLine = state.landingColor.withAlpha(0.9);
    add(landingFeatures, 'landing-point', {
      color: state.landingColor,
      lineWidth: 2,
      lineColor: () => landingLine,
    });
    return { lines, markers, references };
  }

  async function load(viewer) {
    if (state._loading || state._loaded) return;

    state._loading = true;
    state._error = null;
    state._loadingLabel = t('loading...');
    // Ownership token (the militaryAwareness activationId pattern): a
    // disable/abort followed by a fresh enable starts a NEWER load while this
    // one is still settling. The stale load must bail after its await and
    // must never touch shared lifecycle state or the viewer it no longer
    // owns — clearing `_loading`/`_abort` for the successor is how duplicate
    // or post-destroy primitives would get added.
    const generation = ++state._loadGeneration;
    const abort = new AbortController();
    state._abort = abort;
    const owns = () =>
      generation === state._loadGeneration && !abort.signal.aborted;

    try {
      const { cables: cableJson, landingPoints: landingJson } =
        await source.fetch(abort.signal);
      // The fetch is the only await: everything after it runs in this one
      // turn, so no disable or destroy can land between the ownership check
      // and the primitives reaching the scene.
      if (!owns()) return;
      if (
        !Array.isArray(cableJson?.features) ||
        !Array.isArray(landingJson?.features)
      ) {
        throw new TypeError(
          'A cable source must return cables and landingPoints GeoJSON collections',
        );
      }

      const cableFeatures = normalizeFeatures(cableJson, 'cable');
      const landingFeatures = normalizeFeatures(landingJson, 'landing');
      try {
        parts.rendering.buildScene(
          viewer,
          describeScene(cableFeatures, landingFeatures),
        );
      } catch (error) {
        // Leave nothing half built in the scene.
        parts.rendering.destroyScene(viewer);
        throw error;
      }

      state._count = cableFeatures.length + landingFeatures.length;
      state._loaded = true;
      state._lastUpdate = Date.now();
      state._loadingLabel = '';
      parts.rendering.updateVisibility();
      state._referenceSweepGate.markDirty();
      viewer.scene.requestRender?.();
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
