import {
  cartesian2,
  cartesian3,
  cartographic,
  ellipsoid,
  math,
  WGS84,
  ensure,
  near,
  isCartesian3,
} from './helpers.mjs';

export function surfaceChecks(engine, { nadirView, centre }) {
  return [
    [
      'picker.pick: pick, drillPick and pickPosition return contract shapes',
      async () => {
        await nadirView();
        const screen = cartesian2.create(1, 1);
        const picked = engine.picker.pick(screen);
        ensure(
          picked === undefined || 'id' in picked,
          'pick returned no id field',
        );
        const drilled = engine.picker.drillPick(screen, 3);
        ensure(Array.isArray(drilled), 'drillPick did not return an array');
        ensure(drilled.length <= 3, 'drillPick ignored its limit');
        ensure(
          typeof engine.picker.pickPositionSupported === 'boolean',
          'pickPositionSupported is not boolean',
        );
        const position = engine.picker.pickPosition(centre());
        ensure(
          position === undefined || isCartesian3(position),
          'pickPosition is not a Cartesian3',
        );
      },
    ],
    [
      'surface.sampleHeightDetailed: source, tile size and mover-set exclusion',
      async () => {
        const place = cartographic.fromDegrees(20, 10, 0);
        const shape = (detail, label) => {
          if (detail === undefined) return;
          ensure(Number.isFinite(detail.height), `${label}: height`);
          ensure(
            detail.source === 'tiles' || detail.source === 'terrain',
            `${label}: source ${detail.source}`,
          );
          ensure(
            detail.tileSizeM === undefined ||
              (detail.source === 'tiles' && detail.tileSizeM > 0),
            `${label}: tileSizeM ${detail.tileSizeM}`,
          );
        };
        const visible = engine.surface.sampleHeightDetailed(place);
        shape(visible, 'visible');
        if (visible?.source === 'tiles')
          near(
            engine.surface.sampleHeight(place),
            visible.height,
            1e-6,
            'sampleHeight and the detailed tiles answer',
          );
        // A mover set in exclude: the sample works and the set stays.
        const set = engine.movers.createSet({
          id: 'contract-surface-exclude',
          kind: 'point',
          capacity: 1,
          point: { sizePx: 8 },
        });
        try {
          set.set(0, { position: cartesian3.fromDegrees(20, 10, 50) });
          set.setCount(1);
          set.commit();
          shape(
            engine.surface.sampleHeightDetailed(place, { exclude: [set] }),
            'excluding a set',
          );
          ensure(set.id === 'contract-surface-exclude', 'the set has no id');
          ensure(
            engine.movers
              .list()
              .some(({ id }) => id === 'contract-surface-exclude'),
            'the excluded set is gone',
          );
        } finally {
          set.destroy();
        }
      },
    ],
    [
      'surface.sampleHeight: flags, tilesLoaded, sampleHeight, terrainHeight and clampToHeight shapes',
      async () => {
        for (const flag of ['terrainHeightSupported', 'clampToHeightSupported'])
          ensure(
            typeof engine.surface[flag] === 'boolean',
            `${flag} is not boolean`,
          );
        const place = cartographic.fromDegrees(20, 10, 0);
        if (engine.surface.terrainHeightSupported) {
          const terrain = engine.surface.terrainHeight(place);
          ensure(
            terrain === undefined || Number.isFinite(terrain),
            `terrainHeight returned ${terrain}`,
          );
        }
        if (engine.surface.clampToHeightSupported) {
          const clamped = engine.surface.clampToHeight(
            cartesian3.fromDegrees(20, 10, 5000),
          );
          ensure(
            clamped === undefined || isCartesian3(clamped),
            'clampToHeight is not a Cartesian3',
          );
        }
        ensure(
          typeof engine.surface.supported === 'boolean',
          'supported is not boolean',
        );
        ensure(
          typeof engine.surface.tilesLoaded() === 'boolean',
          'tilesLoaded is not boolean',
        );
        if (!engine.surface.supported) return;
        const value = engine.surface.sampleHeight(
          cartographic.fromDegrees(20, 10, 0),
        );
        ensure(
          value === undefined || Number.isFinite(value),
          `sampleHeight returned ${value}`,
        );
      },
    ],
  ];
}

export function globePickChecks(engine, { settle, until, nadirView, centre }) {
  const { camera } = engine;
  return [
    [
      'picker.pickGlobe: the nadir hits the globe and the sky misses',
      async () => {
        await nadirView();
        const hit = engine.picker.pickGlobe(centre());
        ensure(isCartesian3(hit), 'the nadir missed the globe');
        const point = cartographic.fromCartesian(hit, WGS84);
        // Terrain, when shown, stays within Earth's relief of the ellipsoid.
        near(point.height, 0, 9000, 'globe height (m)');
        near(math.toDegrees(point.longitude), 20, 0.05, 'longitude (deg)');
        near(math.toDegrees(point.latitude), 10, 0.05, 'latitude (deg)');
        camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 1e6),
          orientation: { heading: 0, pitch: 0.6, roll: 0 },
        });
        await settle();
        ensure(
          engine.picker.pickGlobe(centre()) === undefined,
          'the sky hit the globe',
        );
      },
    ],
    [
      'picker.pickPosition: projector.worldToWindow round-trip within 1.5 px',
      async () => {
        if (!engine.picker.pickPositionSupported) return;
        // Straight down and tilted; screen points with no surface are skipped.
        // Over New York, low enough for map detail.
        const views = [
          { height: 20000, heading: 0, pitch: -math.PI_OVER_TWO },
          { height: 5000, heading: 0.7, pitch: -1.0 },
        ];
        let hits = 0;
        const misses = [];
        for (const { height: viewHeight, heading, pitch } of views) {
          camera.setView({
            destination: cartesian3.fromDegrees(-73.78, 40.64, viewHeight),
            orientation: { heading, pitch, roll: 0 },
          });
          // Picks read the depth of the last drawn frame: draw this view.
          await settle(3);
          const { width, height } = engine.host.size();
          const screens = [
            [0.5, 0.5],
            [0.3, 0.4],
            [0.7, 0.6],
            [0.5, 0.75],
          ].map(([x, y]) =>
            cartesian2.create(Math.round(width * x), Math.round(height * y)),
          );
          // The depth a pick reads needs drawn frames.
          await until(
            () => engine.picker.pickPosition(screens[0]) !== undefined,
            'a surface under the centre for pickPosition',
          );
          for (const screen of screens) {
            const position = engine.picker.pickPosition(screen);
            if (position === undefined) continue;
            const back = engine.projector.worldToWindow(position);
            const error = back
              ? Math.hypot(back.x - screen.x, back.y - screen.y)
              : Infinity;
            hits += 1;
            if (!(error <= 1.5))
              misses.push(
                `(${screen.x}, ${screen.y}) → ${back ? `(${back.x.toFixed(2)}, ${back.y.toFixed(2)})` : 'undefined'}`,
              );
          }
        }
        ensure(hits > 0, 'pickPosition hit no surface');
        ensure(
          misses.length === 0,
          `round-trip off by more than 1.5 px: ${misses.join('; ')}`,
        );
      },
    ],
  ];
}

export function terrainSampleChecks(engine, { fixtures }) {
  const checks = [
    [
      'surface.sampleTerrainMostDetailed: an empty batch stays empty',
      async () => {
        const result = await engine.surface.sampleTerrainMostDetailed([]);
        ensure(
          Array.isArray(result) && result.length === 0,
          'empty terrain batch',
        );
      },
    ],
    [
      'surface.raycast: a ray away from the globe misses',
      async () => {
        const origin = cartesian3.fromDegrees(20, 10, 1e6);
        const hit = engine.surface.raycast({
          origin,
          direction: cartesian3.normalize(origin, cartesian3.create()),
          far: 1000,
        });
        ensure(hit === undefined, 'outward ray hit a surface');
      },
    ],
  ];
  if (fixtures?.terrain) {
    const { surface, sample } = fixtures.terrain;
    checks.push(
      [
        'surface.sampleTerrainMostDetailed: preserves order and unknown heights',
        async () => {
          const positions = [2, -1, 1].map((longitude) => ({
            longitude,
            latitude: 0,
            height: 99,
          }));
          sample((place) =>
            place.longitude < 0 ? undefined : place.longitude * 10,
          );
          try {
            const result = await surface.sampleTerrainMostDetailed(positions);
            ensure(
              result.length === 3 &&
                Math.abs(result[0] - 20) < 1e-10 &&
                result[1] === undefined &&
                Math.abs(result[2] - 10) < 1e-10,
              `terrain samples ${result}`,
            );
            ensure(
              positions.every((place) => place.height === 99),
              'sampling changed the caller positions',
            );
          } finally {
            sample(null);
          }
        },
      ],
      [
        'surface.sampleTerrainMostDetailed: passes sampling rejection to the caller',
        async () => {
          const failure = new Error('terrain sample unavailable');
          sample(() => {
            throw failure;
          });
          let caught;
          try {
            await surface.sampleTerrainMostDetailed([
              { longitude: 0, latitude: 0 },
            ]);
          } catch (error) {
            caught = error;
          } finally {
            sample(null);
          }
          ensure(
            caught === failure,
            'sampling rejection was swallowed or replaced',
          );
        },
      ],
    );
  }
  return checks;
}
