import {
  featureLabel,
  featureReference,
  normalizeFeatures,
} from './geometry.js';
import * as Cesium from 'cesium';

export function createIngestion({ state, parts, source }) {
  async function load(viewer) {
    if (state._loading || state._loaded) return;

    state._loading = true;
    state._error = null;
    state._loadingLabel = 'loading...';
    // Ownership token (the militaryAwareness activationId pattern): a
    // disable/abort followed by a fresh enable starts a NEWER load while this
    // one is still settling. The stale load must bail after every await and
    // must never touch shared lifecycle state or the viewer it no longer
    // owns — clearing `_loading`/`_abort` for the successor is how duplicate
    // or post-destroy data sources got added.
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

      const cableDataSource = await Cesium.GeoJsonDataSource.load(
        { type: 'FeatureCollection', features: cableFeatures },
        {
          clampToGround: true,
          stroke: state.cableColor.withAlpha(0.95),
          fill: state.cableColor.withAlpha(0.18),
          strokeWidth: 2,
          markerColor: state.cableColor,
          markerSize: 6,
        },
      );
      if (!owns()) return;
      const landingDataSource = await Cesium.GeoJsonDataSource.load(
        { type: 'FeatureCollection', features: landingFeatures },
        {
          clampToGround: true,
          stroke: state.landingColor.withAlpha(0.9),
          fill: state.landingColor.withAlpha(0.35),
          strokeWidth: 2,
          markerColor: state.landingColor,
          markerSize: 6,
        },
      );
      if (!owns()) return;

      cableDataSource.name = `${source.label} Submarine Cables`;
      landingDataSource.name = `${source.label} Landing Points`;
      const referenceDataSource = new Cesium.CustomDataSource(
        `${source.label} Cable References`,
      );
      const addedSources = [
        cableDataSource,
        landingDataSource,
        referenceDataSource,
      ];

      // dataSources.add() is itself an await point: Cesium mutates the
      // collection on a DEFERRED tick, so a disable/destroy racing this
      // window finds nothing to remove and the adds still materialize
      // afterwards. Await every add to settlement (allSettled so a partial
      // failure cannot leave an unawaited add materializing later), then
      // re-check ownership. Pinned teardown mechanism: disable/destroy never
      // wait for in-flight adds — the stale generation's own post-await
      // check here guarantees cleanup by removing exactly the sources THIS
      // generation added.
      const addResults = await Promise.allSettled([
        viewer.dataSources.add(cableDataSource),
        viewer.dataSources.add(landingDataSource),
        viewer.dataSources.add(referenceDataSource),
      ]);
      const rejectedAdd = addResults.find(
        (result) => result.status === 'rejected',
      );
      if (!owns() || rejectedAdd) {
        // Compensate: every add has settled by now, so removal is effective
        // (a remove inside the deferred window would have been a no-op).
        // Remove EVERY generation-local source regardless of settle status:
        // Cesium's add() pushes into the collection BEFORE raising
        // dataSourceAdded, so a REJECTED add may still have landed its
        // mutation. remove() of a never-added source is a harmless no-op.
        for (const source of addedSources) {
          try {
            viewer.dataSources.remove(source, true);
          } catch {
            /* collection gone */
          }
        }
        if (owns() && rejectedAdd) throw rejectedAdd.reason;
        return;
      }

      // Await-free commit: the viewer accepted all three sources and this
      // load still owns the lifecycle.
      state._cableDataSource = cableDataSource;
      state._landingDataSource = landingDataSource;
      state._referenceDataSource = referenceDataSource;

      const cableEntities = state._cableDataSource.entities.values;
      const landingEntities = state._landingDataSource.entities.values;
      state._pickByEntity = new WeakMap();
      state._referenceRecords = [];
      state._surfaceRecords = [];

      cableEntities.forEach((entity, index) => {
        const feature = cableFeatures[index];
        const reference = featureReference(feature);
        if (!reference) return;

        parts.rendering.styleCableEntity(entity, feature);
        parts.interaction.registerPickEntity(entity, {
          kind: 'cable',
          reference,
          label: featureLabel(feature),
        });
        state._surfaceRecords.push({
          entity,
          base: Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 0),
        });
        parts.rendering.addReferenceStem({
          reference,
          label: featureLabel(feature),
          kind: 'cable',
          color: state.cableColor,
          feature,
        });
      });

      landingEntities.forEach((entity, index) => {
        const feature = landingFeatures[index];
        const reference = featureReference(feature);
        if (!reference) return;

        parts.rendering.styleLandingEntity(entity, feature);
        parts.interaction.registerPickEntity(entity, {
          kind: 'landing-point',
          reference,
          label: featureLabel(feature),
        });
        state._surfaceRecords.push({
          entity,
          base: Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 0),
        });
        parts.rendering.addReferenceStem({
          reference,
          label: featureLabel(feature),
          kind: 'landing-point',
          color: state.landingColor,
          feature,
        });
      });

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
        state._error = error?.message || 'TeleGeography load failed';
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
