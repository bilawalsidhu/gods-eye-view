import { createEngineEvent, engineCapabilities } from '../../contract.js';
import { MapSourceController } from '../../../maps/controller.js';
import { cartographic, ensure } from './helpers.mjs';

export function photorealChecks(engine, { settle }) {
  return [
    [
      'maps.setPhotorealTiles: photoreal is inactive',
      async () => {
        engine.maps.setPhotorealTiles(null);
        ensure(
          engine.maps.photorealActive() === false,
          'photoreal still active',
        );
      },
    ],
    [
      'surface.sampleHeightDetailed: leaving photoreal no longer reports tiles',
      async () => {
        const places = [
          cartographic.fromCartesian(engine.camera.pose().position),
          cartographic.fromDegrees(20, 10),
        ].filter(Boolean);
        await engine.maps.setPhotorealTiles(null);
        await settle();
        // Cesium labels every scene hit, the globe included, as tiles; what
        // matters is that no tile geometry answers above the terrain.
        for (const place of places) {
          const sampled = engine.surface.sampleHeightDetailed(place);
          const terrain = engine.surface.terrainHeight(place);
          ensure(
            sampled?.source !== 'tiles' ||
              (Number.isFinite(terrain) &&
                Math.abs(sampled.height - terrain) <= 1),
            'released photoreal tiles still answer surface queries',
          );
        }
      },
    ],
  ];
}

export function terrainChecks(engine) {
  return [
    [
      'maps.setTerrain: keyless terrain resolves; an unknown kind rejects',
      async () => {
        await engine.maps.setTerrain({ id: 'keyless', kind: 'keyless' });
        let rejected = null;
        try {
          await engine.maps.setTerrain({
            id: 'no-such-terrain',
            kind: 'no-such-terrain',
          });
        } catch (error) {
          rejected = error;
        }
        ensure(rejected !== null, 'an unknown terrain kind resolved');
        // The keyless terrain still applies after the rejection.
        await engine.maps.setTerrain({ id: 'keyless', kind: 'keyless' });
      },
    ],
  ];
}

export function mapChecks(maps, { imagery: [first, second], photoreal }) {
  const shows = (baseImagery, tiles, label) => {
    const current = maps.current();
    ensure(
      current.baseImagery === baseImagery,
      `${label}: base imagery is not the expected source`,
    );
    ensure(
      current.photoreal === tiles,
      `${label}: photoreal tiles are not the expected source`,
    );
    ensure(
      maps.photorealActive() === (tiles !== null),
      `${label}: photorealActive is ${maps.photorealActive()}`,
    );
  };
  return [
    [
      'maps.setBaseImagery: setPhotorealTiles(null) brings back the last base imagery',
      async () => {
        await maps.setBaseImagery(first);
        shows(first, null, 'after setBaseImagery');
        await maps.setPhotorealTiles(photoreal);
        shows(null, photoreal, 'tiles replace the base imagery');
        await maps.setPhotorealTiles(null);
        shows(first, null, 'null');
      },
    ],
    [
      'maps.setBaseImagery: the last imagery or photoreal call decides what shows',
      async () => {
        await maps.setBaseImagery(first);
        await Promise.all([
          maps.setBaseImagery(second),
          maps.setPhotorealTiles(photoreal),
        ]);
        shows(null, photoreal, 'tiles last');
        await maps.setPhotorealTiles(null);
        const restored = maps.current().baseImagery;
        // The second source was superseded before or after it showed.
        ensure(
          restored === first || restored === second,
          'null: the last base imagery shown is not back',
        );
        await Promise.all([
          maps.setPhotorealTiles(photoreal),
          maps.setBaseImagery(second),
        ]);
        ensure(
          maps.current().baseImagery === second,
          'imagery last: the second source is not on the globe',
        );
        await maps.setPhotorealTiles(null);
        shows(second, null, 'null after imagery');
      },
    ],
    [
      'maps.releasePhotorealTiles: a released source no longer shows or counts',
      async () => {
        await maps.setPhotorealTiles(photoreal);
        await maps.setPhotorealTiles(null);
        maps.releasePhotorealTiles(photoreal);
        maps.releasePhotorealTiles(photoreal);
        ensure(!maps.photorealActive(), 'photorealActive after release');
        ensure(maps.current().photoreal === null, 'current after release');
      },
    ],
  ];
}

export function terrainRevisionChecks(engine, { fixtures }) {
  return [
    [
      'maps.terrainRevision: changes when setTerrain replaces the surface',
      async () => {
        await engine.maps.setTerrain({ kind: 'ellipsoid' });
        const before = engine.maps.terrainRevision();
        await engine.maps.setTerrain({ kind: 'keyless' });
        ensure(
          engine.maps.terrainRevision() > before,
          'setTerrain kept the terrain revision',
        );
      },
    ],
    [
      'maps.terrainRevision: changes when falling back to the ellipsoid',
      async () => {
        const maps = fixtures?.maps ?? engine.maps;
        await maps.setTerrain(fixtures?.terrainSource ?? { kind: 'keyless' });
        const before = maps.terrainRevision();
        try {
          if (fixtures?.fallbackTerrain) await fixtures.fallbackTerrain();
          else await maps.setTerrain({ kind: 'ellipsoid' });
          ensure(
            maps.terrainRevision() > before,
            'fallback kept the terrain revision',
          );
        } finally {
          await maps.setTerrain(fixtures?.terrainSource ?? { kind: 'keyless' });
        }
      },
    ],
  ];
}

export function mapErrorChecks(engine, { fixtures }) {
  if (!fixtures) return [];
  const maps = fixtures.maps ?? engine.maps;
  const supported = engineCapabilities({ maps }).tileErrors;
  const checks = [
    [
      'maps.errors: tileErrors describes provider error support',
      async () => {
        ensure(
          supported === engineCapabilities(engine).tileErrors,
          'fixture capability differs from the engine',
        );
        if (supported)
          ensure(
            typeof maps.errors.addEventListener === 'function',
            'missing error event',
          );
        else
          ensure(
            maps.errors === undefined,
            'unsupported tile errors were advertised',
          );
      },
    ],
  ];
  if (supported)
    checks.push([
      'maps.errors: forwards source, kind and status and drops replaced providers',
      async () => {
        const first = {
          kind: 'osm',
          provider: { errorEvent: createEngineEvent() },
        };
        const second = {
          kind: 'osm',
          provider: { errorEvent: createEngineEvent() },
        };
        const seen = [];
        const remove = maps.errors.addEventListener((error) =>
          seen.push(error),
        );
        try {
          await maps.setBaseImagery(first);
          first.provider.errorEvent.raiseEvent({ error: { statusCode: 503 } });
          ensure(
            seen.length === 1 &&
              seen[0].source === first &&
              seen[0].kind === 'tile' &&
              seen[0].status === 503,
            'tile error payload',
          );
          await maps.setBaseImagery(second);
          first.provider.errorEvent.raiseEvent({ statusCode: 401 });
          ensure(seen.length === 1, 'replaced imagery reported an error');
          second.provider.errorEvent.raiseEvent({ statusCode: 429 });
          ensure(
            seen.length === 2 &&
              seen[1].source === second &&
              seen[1].status === 429,
            'replacement errors not observed',
          );
        } finally {
          remove();
        }
      },
    ]);
  if (supported)
    checks.push([
      'maps.errors: terrain failures follow the current provider',
      async () => {
        const first = {
          kind: 'keyless',
          provider: { errorEvent: createEngineEvent() },
        };
        const second = {
          kind: 'ellipsoid',
          provider: { errorEvent: createEngineEvent() },
        };
        first.create = () => ({ provider: first.provider });
        second.create = () => ({ provider: second.provider, fallback: true });
        const seen = [];
        const remove = maps.errors.addEventListener((error) =>
          seen.push(error),
        );
        try {
          await maps.setTerrain(first);
          first.provider.errorEvent.raiseEvent({ error: { statusCode: 503 } });
          ensure(
            seen.length === 1 &&
              seen[0].source === first &&
              seen[0].kind === 'terrain' &&
              seen[0].status === 503,
            'terrain error payload',
          );
          await maps.setTerrain(second);
          first.provider.errorEvent.raiseEvent({ statusCode: 401 });
          ensure(seen.length === 1, 'replaced terrain reported an error');
          second.provider.errorEvent.raiseEvent({});
          ensure(
            seen.length === 2 &&
              seen[1].source === second &&
              seen[1].kind === 'terrain' &&
              seen[1].status === undefined,
            'unknown terrain status',
          );
        } finally {
          remove();
        }
      },
    ]);
  for (const enabled of supported ? [true, false] : [false])
    checks.push([
      `maps.errors: tile failure fallback ${enabled ? 'runs with' : 'stays off without'} tileErrors`,
      async () => {
        const providers = [createEngineEvent(), createEngineEvent()];
        const sources = ['contract-primary', 'contract-fallback'].map(
          (id, i) => ({
            descriptor: { id, label: id, kind: 'osm' },
            imagery: async () => ({ errorEvent: providers[i] }),
            ...(i === 0 && {
              tileFailureFallback: {
                id: 'contract-fallback',
                threshold: 2,
                message: 'Map tiles unavailable',
              },
            }),
          }),
        );
        const events = [];
        const controlled = {
          ...engine,
          maps: enabled ? maps : { ...maps, errors: undefined },
        };
        const controller = new MapSourceController({
          engine: controlled,
          registry: { defaultId: 'contract-primary', sources },
          initialStack: 'contract-primary',
          onChange: (state) => events.push(state),
        });
        try {
          await controller.setStack('contract-primary');
          const source = maps.current().baseImagery;
          if (enabled) {
            maps.errors.raiseEvent({ source, kind: 'terrain', status: 503 });
            maps.errors.raiseEvent({ source: {}, kind: 'tile', status: 503 });
            ensure(
              controller.getActiveId() === 'contract-primary',
              'unrelated errors switched the map',
            );
            maps.errors.raiseEvent({ source, kind: 'tile', status: 503 });
            ensure(
              controller.getActiveId() === 'contract-primary',
              'one tile error switched the map',
            );
            maps.errors.raiseEvent({ source, kind: 'tile', status: 503 });
          } else {
            providers[0].raiseEvent({ statusCode: 503 });
            providers[0].raiseEvent({ statusCode: 503 });
          }
          for (let i = 0; i < 60; i++) await Promise.resolve();
          ensure(
            controller.getActiveId() ===
              (enabled ? 'contract-fallback' : 'contract-primary'),
            'tile failure fallback ignored the capability',
          );
          if (!enabled)
            ensure(
              controller.getState().lastError === null &&
                events.at(-1)?.status === 'ready',
              'unsupported errors prevented map readiness',
            );
        } finally {
          controller.destroy();
        }
      },
    ]);
  return checks;
}
