import {
  cartesian3,
  ellipsoid,
  math,
  throwsType,
  like,
  MAGENTA,
  GREEN,
  show,
  screenOf,
  WGS84,
  RADIAL_RADIUS_M,
  RADIAL_VIEW_M,
  ensure,
  along,
  near,
  nearColour,
  meanAt,
} from './helpers.mjs';

export function groundChecks(
  engine,
  { settle, until, nadirView, readRegion, pointer },
) {
  const { ground } = engine;
  const cell = (west, south, east, north, extra = {}) => ({
    west,
    south,
    east,
    north,
    ...extra,
  });
  const square = (lon, lat, half) => [
    [lon - half, lat - half],
    [lon + half, lat - half],
    [lon + half, lat + half],
    [lon - half, lat + half],
  ];

  return [
    [
      'projector.horizonVisible: a lowered horizon ellipsoid keeps below-sea-level ground visible',
      async () => {
        const eye = cartesian3.fromDegrees(-74.006, 40.7128, -19.6);
        engine.camera.setView({ destination: eye });
        await settle();
        const point = cartesian3.fromDegrees(-74.006, 40.71289, -22);
        const options = {
          ellipsoid: {
            radii: { x: 6377137, y: 6377137, z: 6355752.314245179 },
          },
        };
        ensure(
          engine.projector.horizonVisible(point, options),
          'nearby ground below WGS84 stays visible',
        );
        ensure(
          !engine.projector.horizonVisible(
            cartesian3.fromDegrees(105.994, -40.7128),
            options,
          ),
          'far side stays hidden',
        );
        throwsType(
          () =>
            engine.projector.horizonVisible(point, {
              ellipsoid: { radii: { x: 0, y: 1, z: 1 } },
            }),
          'zero horizon radius',
        );
        await nadirView(1e6);
      },
    ],
    [
      'ground.createSet: corridor reveals advance without replacing their path',
      async () => {
        const set = ground.createSet({
          id: 'contract-reveal',
          kind: 'corridor',
          reveal: true,
        });
        try {
          set.replace([
            {
              positions: [
                [19.7, 10],
                [20.3, 10],
              ],
              widthPx: 12,
              color: [1, 0, 1, 1],
            },
          ]);
          set.commit();
          set.setReveal(0.25);
          throwsType(() => set.setReveal(-1), 'negative reveal');
          throwsType(() => set.setReveal(2), 'large reveal');
          if (!readRegion) return;
          await nadirView(350000);
          await until(() => set.ready(), 'reveal ground ready');
          await settle();
          const magenta = (lon) => {
            const { x, y } = screenOf(engine, lon, 10);
            const p = readRegion(Math.round(x), Math.round(y), 1, 1);
            return Math.min(p[0], p[2]) - p[1];
          };
          ensure(magenta(19.8) > 60, 'revealed start draws');
          ensure(magenta(20.2) < 60, 'unrevealed end is hidden');
          set.setReveal(0.9);
          await settle();
          ensure(magenta(20.2) > 60, 'reveal advances over the existing path');
        } finally {
          set.destroy();
        }
      },
    ],
    [
      'ground.createPulseField: pulse fields update fronts, move, hide and release without a clock',
      async () => {
        const options = {
          id: 'contract-ground-pulses',
          center: cartesian3.fromDegrees(20, 10),
          radiusM: 250000,
          heightM: 2500,
          color: [0, 1, 1, 0.25],
          lineColor: [0, 1, 1, 1],
          haloColor: [0, 0, 0, 0.8],
          depth: 0.35,
          lineWidth: 3,
          haloWidth: 1,
        };
        throwsType(
          () => ground.createPulseField({ ...options, radiusM: -1 }),
          'negative radius',
        );
        const field = ground.createPulseField(options);
        const listed = () => ground.list().find(({ id }) => id === options.id);
        try {
          ensure(!listed().shown, 'new field is visible');
          field.draw({ radii: [0.2, 0.6], alphas: [0.4, 0.2], level: 1 });
          ensure(
            listed().shown && !listed().animated,
            'caller-driven field starts no clock',
          );
          throwsType(
            () => field.draw({ radii: [2], alphas: [1], level: 1 }),
            'invalid front',
          );
          ensure(listed().shown, 'invalid update changed visibility');
          field.move(cartesian3.fromDegrees(21, 10));
          await settle();
          field.draw({ radii: [], alphas: [], level: 0 });
          ensure(!listed().shown, 'resting field is visible');
        } finally {
          field.destroy();
        }
        field.destroy();
        field.draw({ radii: [0.5], alphas: [1], level: 1 });
        ensure(field.isDestroyed() && !listed(), 'destroyed field retained');
      },
    ],
    [
      'ground.createPulseField: pulse bands change pixels and rest clears them',
      async () => {
        if (!readRegion) return;
        await nadirView(1e6);
        // The base frame must be the settled surface: a check before this one
        // can leave tiles of another view still loading.
        await until(
          () => engine.surface.tilesLoaded?.() !== false,
          'surface settles',
        );
        await settle(5);
        const at = engine.projector.worldToWindow(
          cartesian3.fromDegrees(20.9, 10, 2500),
        );
        const sample = () =>
          readRegion(Math.round(at.x) - 3, Math.round(at.y) - 3, 6, 6);
        const base = sample();
        const difference = (a, b) => {
          let sum = 0;
          for (let i = 0; i < a.length; i++)
            if (i % 4 !== 3) sum += Math.abs(a[i] - b[i]);
          return sum / (a.length * 0.75);
        };
        const field = ground.createPulseField({
          id: 'contract-pulse-pixels',
          center: cartesian3.fromDegrees(20, 10),
          radiusM: 200000,
          heightM: 2500,
          color: [1, 0, 1, 1],
          lineColor: [1, 0, 1, 1],
          haloColor: [0, 0, 0, 1],
          depth: 0.5,
          lineWidth: 3,
          haloWidth: 1,
        });
        try {
          field.draw({ radii: [0.6], alphas: [1], level: 1 });
          await until(
            () => difference(sample(), base) > 25,
            'pulse band draws',
          );
          field.draw({ radii: [0.2], alphas: [1], level: 1 });
          await until(
            () => difference(sample(), base) < 10,
            'front moves past the sampled band',
          );
          field.draw({ radii: [0.6], alphas: [1], level: 1 });
          await until(() => difference(sample(), base) > 25, 'front returns');
          field.draw({ radii: [0.6], alphas: [1], level: 0 });
          await until(
            () => difference(sample(), base) < 10,
            'rest clears the field',
          );
        } finally {
          field.destroy();
        }
      },
    ],
    [
      'ground.createSet: sets are created, committed, listed, shown, hidden and destroyed',
      async () => {
        throwsType(
          () => ground.createSet({ id: 'contract-bad', kind: 'blob' }),
          'an unknown kind',
        );
        throwsType(
          () =>
            ground.createSet({ id: 'contract-bad', kind: 'cell', drape: 'x' }),
          'an unknown drape',
        );
        const set = ground.createSet({
          id: 'contract-ground',
          kind: 'polygon',
          order: 3,
        });
        const others = [];
        try {
          let duplicate = null;
          try {
            ground.createSet({ id: 'contract-ground', kind: 'disc' });
          } catch (error) {
            duplicate = error;
          }
          ensure(duplicate, 'a second live set with the same id');
          ensure(set.id === 'contract-ground', `id ${set.id}`);
          ensure(
            listed()?.kind === 'polygon' &&
              listed().count === 0 &&
              listed().shown === true &&
              listed().order === 3,
            `list() before a commit: ${JSON.stringify(listed())}`,
          );
          set.replace([
            {
              rings: [square(20, 10, 0.5), square(20, 10, 0.2).reverse()],
              fill: [1, 0, 0, 0.5],
              outline: { color: [1, 1, 1, 1], widthPx: 2 },
              pickId: 'p1',
            },
            {
              rings: [[...square(21, 10, 0.3), [20.7, 9.7]]],
              fill: [0, 1, 0, 1],
            },
          ]);
          ensure(set.count() === 0, 'replace() drew before commit()');
          set.commit();
          ensure(set.count() === 2, `count ${set.count()} after commit`);
          ensure(listed()?.count === 2, 'list() missed the commit');
          throwsType(
            () =>
              set.replace([
                {
                  rings: [
                    [
                      [0, 0],
                      [1, 1],
                    ],
                  ],
                },
              ]),
            'a ring of two positions',
          );
          throwsType(
            () =>
              set.replace([{ rings: [square(0, 0, 1)], fill: [2, 0, 0, 1] }]),
            'a fill outside 0..1',
          );
          set.commit();
          ensure(set.count() === 2, 'a refused replace() changed the set');
          await until(() => set.ready(), 'the polygons drawn');
          set.show(false);
          ensure(
            set.shown() === false && listed()?.shown === false,
            'show(false) not reported',
          );
          set.show(true);
          ensure(set.shown() === true, 'show(true) not reported');
          // Every kind takes its own items.
          const disc = ground.createSet({ id: 'contract-discs', kind: 'disc' });
          others.push(disc);
          disc.replace([
            {
              center: [20, 10],
              radiusM: 20_000,
              fill: [0, 0, 1, 0.4],
              outline: { color: [0, 0, 1, 1], widthPx: 3 },
            },
          ]);
          disc.commit();
          const cells = ground.createSet({
            id: 'contract-cells',
            kind: 'cell',
          });
          others.push(cells);
          cells.replace([
            cell(179.5, 0, -179.5, 1, { fill: [1, 1, 0, 0.5] }),
            cell(20, 10, 20.5, 10.5, { fill: [1, 1, 0, 0.5] }),
          ]);
          cells.commit();
          const corridors = ground.createSet({
            id: 'contract-corridors',
            kind: 'corridor',
          });
          others.push(corridors);
          corridors.replace([
            {
              positions: [
                [19, 9],
                [21, 9],
              ],
              color: [1, 0, 1, 1],
              widthPx: 4,
            },
            {
              positions: [
                [19, 11],
                [20, 11.2],
                [21, 11],
              ],
              color: [0, 1, 1, 1],
              widthM: 5000,
            },
          ]);
          corridors.commit();
          throwsType(
            () =>
              corridors.replace([
                {
                  positions: [
                    [0, 0],
                    [1, 0],
                  ],
                  color: [1, 1, 1, 1],
                },
              ]),
            'a corridor without a width',
          );
          await until(
            () => others.every((other) => other.ready()),
            'discs, cells and corridors drawn',
          );
          ensure(
            ['contract-discs', 'contract-cells', 'contract-corridors'].every(
              (id) => ground.list().some((entry) => entry.id === id),
            ),
            'list() misses a set',
          );
          set.replace([]);
          set.commit();
          ensure(set.count() === 0, 'an empty commit kept items');
        } finally {
          set.destroy();
          for (const other of others) other.destroy();
        }
        ensure(!listed(), 'a destroyed set is still listed');
        set.destroy();
        let refused = null;
        try {
          set.commit();
        } catch (error) {
          refused = error;
        }
        ensure(refused, 'a destroyed set took a commit');
        function listed() {
          return ground.list().find(({ id }) => id === 'contract-ground');
        }
      },
    ],
    [
      'ground.createSet: picks resolve to the pickId of the item on top',
      async () => {
        await nadirView(1e6);
        const cells = ground.createSet({
          id: 'contract-ground-cells',
          kind: 'cell',
          pickable: true,
        });
        const polygons = ground.createSet({
          id: 'contract-ground-polygons',
          kind: 'polygon',
          pickable: true,
          order: 1,
        });
        const quiet = ground.createSet({
          id: 'contract-ground-quiet',
          kind: 'disc',
        });
        const clicks = [];
        const remove = engine.input.on('click', (event) => clicks.push(event), {
          pick: true,
        });
        try {
          cells.replace([
            cell(19, 9.5, 20, 10.5, { fill: [1, 0, 0, 0.6], pickId: 'cell-a' }),
            cell(19.2, 9.7, 19.4, 9.9, { fill: [1, 0, 0, 0.6] }),
          ]);
          cells.commit();
          polygons.replace([
            {
              rings: [square(20.6, 10, 0.4)],
              fill: [0, 0, 1, 0.6],
              pickId: 'poly-b',
            },
          ]);
          polygons.commit();
          quiet.replace([
            {
              center: [20.6, 10],
              radiusM: 15_000,
              fill: [0, 1, 0, 0.6],
              pickId: 'q',
            },
          ]);
          quiet.commit();
          await until(
            () => cells.ready() && polygons.ready() && quiet.ready(),
            'the pickable fills drawn',
          );
          await settle(3);
          const pickAt = (lon, lat) =>
            engine.picker.pick(screenOf(engine, lon, lat));
          const onCell = pickAt(19.5, 10.2);
          ensure(
            onCell?.id === 'cell-a' && onCell.owner === 'contract-ground-cells',
            `a pick on the cell found ${JSON.stringify(onCell?.id)} of ${onCell?.owner}`,
          );
          ensure(onCell.instance === 0, `instance ${onCell.instance}`);
          const noId = pickAt(19.3, 9.8);
          ensure(
            noId?.owner !== 'contract-ground-cells' || noId.id === 'cell-a',
            `an item without a pickId was picked (${JSON.stringify(noId?.id)})`,
          );
          // Higher order on top, an unpickable set under it never answers.
          const onPolygon = pickAt(20.6, 10.25);
          ensure(
            onPolygon?.id === 'poly-b',
            `a pick on the polygon found ${JSON.stringify(onPolygon?.id)}`,
          );
          const onQuiet = pickAt(20.6, 10);
          ensure(
            onQuiet?.id === 'poly-b' &&
              onQuiet.owner !== 'contract-ground-quiet',
            `the unpickable disc answered (${JSON.stringify(onQuiet?.id)} of ${onQuiet?.owner})`,
          );
          const outside = pickAt(18, 12);
          ensure(
            outside === undefined || outside.id === undefined,
            `a pick off every fill found ${JSON.stringify(outside?.id)}`,
          );
          polygons.show(false);
          await settle(3);
          const hidden = pickAt(20.6, 10.25);
          ensure(hidden?.id !== 'poly-b', 'a hidden set answered a pick');
          polygons.show(true);
          await settle(3);
          if (!pointer) return;
          const before = clicks.length;
          const at = screenOf(engine, 19.5, 10.2);
          await pointer.click(at.x, at.y);
          await until(() => clicks.length > before, 'a click payload');
          const clicked = clicks.at(-1);
          ensure(
            clicked.picked?.id === 'cell-a',
            `a click on the cell picked ${JSON.stringify(clicked.picked?.id)}`,
          );
        } finally {
          remove();
          cells.destroy();
          polygons.destroy();
          quiet.destroy();
        }
      },
    ],
    [
      'ground.createSet: fills, outlines and corridors draw on the globe (pixels)',
      async () => {
        if (!readRegion) return;
        await nadirView(1e6);
        const MAGENTA = [1, 0, 1, 1];
        const GREEN = [0, 1, 0, 1];

        // Pixels of a colour in a box centred on a ground point.
        const countAt = (lon, lat, colour, half = 12) => {
          const { x, y } = screenOf(engine, lon, lat);
          const data = readRegion(
            Math.round(x) - half,
            Math.round(y) - half,
            2 * half,
            2 * half,
          );
          let count = 0;
          for (let i = 0; i < data.length; i += 4)
            if (like(colour, data, i)) count++;
          return count / (4 * half * half);
        };
        const cells = ground.createSet({
          id: 'contract-paint-cells',
          kind: 'cell',
        });
        const discs = ground.createSet({
          id: 'contract-paint-discs',
          kind: 'disc',
          order: 1,
        });
        const corridors = ground.createSet({
          id: 'contract-paint-corridors',
          kind: 'corridor',
          order: 2,
        });
        const extra = [];
        try {
          ensure(
            countAt(19.5, 10, MAGENTA) < 0.05,
            'the globe is already magenta under the cell',
          );
          cells.replace([cell(19, 9.5, 20, 10.5, { fill: MAGENTA })]);
          cells.commit();
          discs.replace([
            {
              center: [21, 10],
              radiusM: 40_000,
              fill: GREEN,
              outline: { color: MAGENTA, widthPx: 4 },
            },
          ]);
          discs.commit();
          corridors.replace([
            {
              positions: [
                [19, 8.5],
                [21, 8.5],
              ],
              color: GREEN,
              widthPx: 6,
            },
          ]);
          corridors.commit();
          await until(
            () => cells.ready() && discs.ready() && corridors.ready(),
            'the fills built',
          );
          await until(
            () => countAt(19.5, 10, MAGENTA) > 0.9,
            'the magenta cell drawn',
          );
          ensure(
            countAt(21, 10, GREEN, 8) > 0.9,
            `the disc's centre is ${countAt(21, 10, GREEN, 8).toFixed(2)} green`,
          );
          // The outline: magenta on the disc's rim, 40 km east of its centre.
          const rimLon = 21 + 40_000 / (111_320 * Math.cos(math.toRadians(10)));
          ensure(
            countAt(rimLon, 10, MAGENTA, 3) > 0.3,
            `the disc's outline is ${countAt(rimLon, 10, MAGENTA, 3).toFixed(2)} magenta at the rim`,
          );
          // A 6 px corridor: a column of pixels across it.
          const mid = screenOf(engine, 20, 8.5);
          const column = readRegion(
            Math.round(mid.x),
            Math.round(mid.y) - 10,
            1,
            20,
          );
          let lit = 0;
          for (let i = 0; i < column.length; i += 4)
            if (like(GREEN, column, i)) lit++;
          ensure(lit >= 4 && lit <= 8, `the 6 px corridor is ${lit} px wide`);
          cells.show(false);
          await until(
            () => countAt(19.5, 10, MAGENTA) < 0.05,
            'the hidden cell gone',
          );
          cells.show(true);
          await until(
            () => countAt(19.5, 10, MAGENTA) > 0.9,
            'the cell shown again',
          );
          cells.replace([]);
          cells.commit();
          await until(
            () => countAt(19.5, 10, MAGENTA) < 0.05,
            'the emptied cell gone',
          );
          // A polygon of many vertices with a hole (engines may bin it).
          const ring = (radius, count) =>
            Array.from({ length: count }, (_, index) => {
              const angle = (index / count) * 2 * Math.PI;
              return [
                18 + radius * Math.cos(angle),
                11 + radius * Math.sin(angle),
              ];
            });
          const many = ground.createSet({
            id: 'contract-paint-polygon',
            kind: 'polygon',
          });
          extra.push(many);
          many.replace([
            { rings: [ring(0.7, 240), ring(0.25, 120)], fill: MAGENTA },
          ]);
          many.commit();
          await until(() => many.ready(), 'the large polygon built');
          await until(
            () => countAt(18.45, 11, MAGENTA, 6) > 0.9,
            'the large polygon drawn',
          );
          ensure(
            countAt(18, 11, MAGENTA, 6) < 0.05,
            `the hole is ${countAt(18, 11, MAGENTA, 6).toFixed(2)} magenta`,
          );
          ensure(
            countAt(18, 12.2, MAGENTA, 6) < 0.05,
            'the large polygon spills outside its ring',
          );
          // Round both rings, just inside and just outside each.
          for (let step = 0; step < 12; step++) {
            const angle = (step / 12) * 2 * Math.PI + 0.1;
            const at = (radius) => [
              18 + radius * Math.cos(angle),
              11 + radius * Math.sin(angle),
            ];
            for (const [radius, filled] of [
              [0.62, true],
              [0.78, false],
              [0.33, true],
              [0.17, false],
            ]) {
              const share = countAt(...at(radius), MAGENTA, 2);
              ensure(
                filled ? share > 0.9 : share < 0.1,
                `at ${radius}° from the centre, ${(step * 30).toFixed(0)}° round: ${share.toFixed(2)} magenta`,
              );
            }
          }
        } finally {
          cells.destroy();
          discs.destroy();
          corridors.destroy();
          for (const set of extra) set.destroy();
        }
      },
    ],
    [
      'ground.createSet: corridors glow, pulse and dash, and keep frames coming while they move',
      async () => {
        const line = (lat, extra) => ({
          positions: [
            [19, lat],
            [21, lat],
          ],
          color: [1, 0, 1, 1],
          widthPx: 12,
          ...extra,
        });
        const bad = ground.createSet({
          id: 'contract-looks-bad',
          kind: 'corridor',
        });
        try {
          for (const [item, label] of [
            [
              {
                ...line(9, { glow: { power: 0.25 } }),
                widthPx: undefined,
                widthM: 900,
              },
              'a glow on a metre corridor',
            ],
            [
              line(9, { pulse: { periodMs: 1000, min: 0.8, max: 0.2 } }),
              'a pulse min over max',
            ],
            [
              line(9, { pulse: { periodMs: 0, min: 0, max: 1 } }),
              'a pulse of no period',
            ],
            [
              line(9, { dash: { cells: 8, duty: 1 } }),
              'a dash lit all its cell',
            ],
            [line(9, { glow: { power: 0 } }), 'a glow of no power'],
          ])
            throwsType(() => bad.replace([item]), label);
        } finally {
          bad.destroy();
        }
        const glowing = ground.createSet({
          id: 'contract-glow',
          kind: 'corridor',
          order: 5,
        });
        const pulsing = ground.createSet({
          id: 'contract-pulse',
          kind: 'corridor',
          order: 5,
        });
        const dashed = ground.createSet({
          id: 'contract-dash',
          kind: 'corridor',
          order: 5,
        });
        const listed = (id) => ground.list().find((entry) => entry.id === id);
        // Frames drawn in a window, with nothing asked of the engine.
        const framesIn = async (ms) => {
          let frames = 0;
          const remove = engine.frames.postRender.addEventListener(
            () => frames++,
          );
          await new Promise((resolve) => setTimeout(resolve, ms));
          remove();
          return frames;
        };
        try {
          if (readRegion) await nadirView(1e6);
          const idle = readRegion ? await framesIn(1000) : 0;
          glowing.replace([
            line(9, {
              color: [0, 1, 0, 1],
              widthPx: 24,
              glow: { power: 0.25 },
            }),
          ]);
          glowing.commit();
          ensure(
            listed('contract-glow')?.animated === false,
            'a glow alone does not animate',
          );
          pulsing.replace([
            line(10, { pulse: { periodMs: 800, min: 0.1, max: 1 } }),
          ]);
          pulsing.commit();
          ensure(
            listed('contract-pulse')?.animated === true,
            'a pulse animates',
          );
          dashed.replace([
            line(11, { dash: { cells: 10, duty: 0.5, speed: 2 } }),
          ]);
          dashed.commit();
          ensure(listed('contract-dash')?.animated === true, 'a dash animates');
          await until(
            () => glowing.ready() && pulsing.ready() && dashed.ready(),
            'the animated corridors built',
          );
          if (!readRegion) return;
          // (A page that already draws every frame shows nothing more.)
          const moving = await framesIn(1000);
          ensure(
            moving >= Math.min(idle + 20, 50),
            `${moving} frames in 1 s while corridors pulse and flow, ${idle} before`,
          );
          // Pixels along a line of latitude between 19.2° and 20.8°E.
          const along = (lat, samples = 120) => {
            const out = [];
            for (let k = 0; k < samples; k++) {
              const at = screenOf(
                engine,
                19.2 + (1.6 * k) / (samples - 1),
                lat,
              );
              out.push([
                ...readRegion(Math.round(at.x), Math.round(at.y), 1, 1),
              ]);
            }
            return out;
          };
          const magenta = ([r, g, b]) => r > 200 && b > 200 && g < 60;
          // The glow: white at its centre line, green toward its edges.
          {
            const centre = screenOf(engine, 20, 9);
            const column = readRegion(
              Math.round(centre.x),
              Math.round(centre.y) - 12,
              1,
              25,
            );
            const mid = column.slice(12 * 4, 12 * 4 + 4);
            ensure(
              mid[0] > 200 && mid[1] > 200 && mid[2] > 200,
              `the glow's centre is ${[...mid.slice(0, 3)]}, not white`,
            );
            let greenish = 0;
            for (let i = 0; i < column.length; i += 4)
              if (column[i + 1] > 120 && column[i] < column[i + 1] - 60)
                greenish++;
            ensure(
              greenish >= 2,
              `the glow fades to green over ${greenish} px`,
            );
          }
          // The pulse: magenta at its peak, faint at its trough.
          {
            let peak = 0;
            let trough = 0;
            const started = performance.now();
            while (performance.now() - started < 1600) {
              const centre = screenOf(engine, 20, 10);
              const pixel = readRegion(
                Math.round(centre.x),
                Math.round(centre.y),
                1,
                1,
              );
              if (magenta(pixel)) peak++;
              else trough++;
              await settle(1);
            }
            ensure(
              peak > 0 && trough > 0,
              `the pulse was magenta ${peak} times, not ${trough}`,
            );
          }
          // The dash: lit and dark cells along the line, moving.
          {
            const first = along(11).map(magenta);
            let changes = 0;
            for (let k = 1; k < first.length; k++)
              if (first[k] !== first[k - 1]) changes++;
            const lit = first.filter(Boolean).length / first.length;
            ensure(
              changes >= 8 && lit > 0.25 && lit < 0.75,
              `the dash is ${lit.toFixed(2)} lit with ${changes} changes along it`,
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            await settle(2);
            const second = along(11).map(magenta);
            const moved = second.filter(
              (value, k) => value !== first[k],
            ).length;
            ensure(
              moved >= 12,
              `the dash moved at ${moved} of 120 pixels in 150 ms`,
            );
          }
          pulsing.show(false);
          dashed.show(false);
          await settle(2);
          const still = await framesIn(1000);
          ensure(
            still <= idle + 3,
            `${still} frames in 1 s once hidden, ${idle} before`,
          );
        } finally {
          glowing.destroy();
          pulsing.destroy();
          dashed.destroy();
        }
      },
    ],
    [
      'ground.createSet: radial discs retain their look and draw a brighter rim than fill',
      async () => {
        const background = ground.createSet({
          id: 'contract-radial-background',
          kind: 'cell',
        });
        const disc = ground.createSet({
          id: 'contract-radial',
          kind: 'disc',
          order: 1,
        });
        try {
          background.replace([
            { west: 19, south: 9, east: 21, north: 11, fill: [0, 0, 0, 1] },
          ]);
          background.commit();
          disc.replace([
            {
              center: [20, 10],
              // A launch pad's size: Cesium maps a large ground disc's
              // texture coordinates differently, and only pads use this look.
              radiusM: RADIAL_RADIUS_M,
              fill: [0, 1, 1, 1],
              radial: {
                fillAlpha: 0.105,
                rimAlpha: 0.72,
                rimStart: 0.952,
                rimEnd: 0.985,
                emission: 0.35,
              },
            },
          ]);
          disc.commit();
          ensure(
            ground.list().find((set) => set.id === 'contract-radial').count ===
              1,
            'radial disc committed',
          );
          if (!readRegion) return;
          await nadirView(RADIAL_VIEW_M);
          await until(
            () => disc.ready() && background.ready(),
            'radial ground ready',
          );
          await settle();
          const metresPerDegree = 111319.49 * Math.cos((10 * Math.PI) / 180);
          const at = (radius, angle) => {
            const { x, y } = screenOf(
              engine,
              20 + (radius * Math.cos(angle)) / metresPerDegree,
              10 + (radius * Math.sin(angle)) / 110574,
            );
            const bytes = readRegion(Math.round(x), Math.round(y), 1, 1);
            return bytes[1] + bytes[2];
          };
          // Cesium leaves part of a small ground disc's fill undrawn (its
          // old launch pad shows the same gap): the brightest inner sample.
          const fillAt = () =>
            Math.max(
              ...[0, 1, 2, 3, 4, 5].map((k) =>
                at(RADIAL_RADIUS_M * 0.5, (k * Math.PI) / 3),
              ),
            );
          // Cesium classifies onto the terrain loaded at this height, which
          // can take longer than the usual frame budget after the descent.
          // The app's own arrival flight can land after the view was set:
          // the view is set again until the disc draws.
          // Pixels come from the last drawn frame, screen positions from the
          // camera now: both must be at the view, with no flight under way.
          const away = () =>
            engine.camera.flightActive() ||
            engine.camera.height() > RADIAL_VIEW_M * 1.5;
          for (
            let frame = 0;
            frame < 1200 && (away() || fillAt() <= 5);
            frame++
          ) {
            if (away()) {
              engine.camera.cancelFlight();
              await nadirView(RADIAL_VIEW_M);
            }
            await settle(1);
          }
          const fill = fillAt();
          // The rim is a few pixels wide: its brightest sample across it.
          let rim = 0;
          for (let step = 0; step <= 25; step++)
            rim = Math.max(rim, at(RADIAL_RADIUS_M * (0.85 + step * 0.01), 0));
          ensure(fill > 5, `radial fill is visible: ${fill}`);
          ensure(
            rim > fill + 50,
            `radial rim ${rim} is brighter than fill ${fill}`,
          );
          disc.show(false);
          await settle();
          ensure(fillAt() < fill, 'hidden radial fill clears');
        } finally {
          disc.destroy();
          background.destroy();
        }
      },
    ],
  ];
}

export function groundBehaviourChecks(
  engine,
  { settle, until, nadirView, centre, readRegion, fixtures, mapSources },
) {
  const checks = [
    [
      'ground.createSet: a ground fill colour draws as asked within 10 per channel',
      async () => {
        await nadirView(10000);
        const set = engine.ground.createSet({
          id: 'contract-fill-colour',
          kind: 'cell',
        });
        try {
          set.replace([
            {
              west: 19.98,
              south: 9.98,
              east: 20.02,
              north: 10.02,
              fill: [0.2, 0.6, 0.4, 1],
            },
          ]);
          set.commit();
          await until(() => set.ready(), 'ground fill ready');
          if (readRegion)
            await until(
              () =>
                nearColour(
                  meanAt(engine, readRegion, 20, 10, 2),
                  [51, 153, 102],
                  10,
                ),
              'ground colour within 10 per channel',
            );
        } finally {
          set.destroy();
        }
      },
    ],
    [
      'ground.createSet: terrain drape draws on the terrain surface',
      async () => {
        await engine.maps.setPhotorealTiles(null);
        await nadirView(10000);
        const set = engine.ground.createSet({
          id: 'contract-terrain-drape',
          kind: 'cell',
          drape: 'terrain',
          pickable: true,
        });
        try {
          set.replace([
            {
              west: 19.98,
              south: 9.98,
              east: 20.02,
              north: 10.02,
              fill: [1, 0, 1, 1],
              pickId: 'terrain-drape',
            },
          ]);
          set.commit();
          await until(() => set.ready(), 'terrain drape ready');
          await until(
            () => engine.picker.pick(centre())?.id === 'terrain-drape',
            'terrain drape pick',
          );
          if (readRegion)
            await until(
              () =>
                nearColour(meanAt(engine, readRegion, 20, 10, 2), MAGENTA, 10),
              'terrain drape pixels',
            );
          if (fixtures?.tiles) {
            await engine.maps.setPhotorealTiles(mapSources.photoreal);
            ensure(
              engine.picker.pick(centre())?.id !== 'terrain-drape',
              'terrain drape picked on tiles',
            );
          }
        } finally {
          set.destroy();
          await engine.maps.setPhotorealTiles(null);
        }
      },
    ],
    [
      'ground.createSet: corridor width is in CSS pixels at the device scale',
      async () => {
        await nadirView(10000);
        const set = engine.ground.createSet({
          id: 'contract-corridor-width',
          kind: 'corridor',
        });
        try {
          set.replace([
            {
              positions: [
                [19.98, 10],
                [20.02, 10],
              ],
              widthPx: 12,
              color: [1, 0, 1, 1],
            },
          ]);
          set.commit();
          await until(() => set.ready(), 'pixel corridor ready');
          await settle(3);
          if (!readRegion) return;
          const { x, y } = centre();
          const pixels = readRegion(Math.round(x), Math.round(y) - 24, 1, 48);
          let width = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i] > 200 && pixels[i + 1] < 70 && pixels[i + 2] > 200)
              width++;
          near(width, 12, 2, 'corridor CSS width');
        } finally {
          set.destroy();
        }
      },
    ],
  ];
  if (fixtures?.tiles)
    checks.push([
      'ground.createSet: tiles drape ignores terrain and picks only tiles',
      async () => {
        await nadirView(10000);
        const set = engine.ground.createSet({
          id: 'contract-tiles-drape',
          kind: 'cell',
          drape: 'tiles',
          pickable: true,
        });
        try {
          set.replace([
            {
              west: 19.98,
              south: 9.98,
              east: 20.02,
              north: 10.02,
              fill: [1, 0, 1, 1],
              pickId: 'tiles-drape',
            },
          ]);
          set.commit();
          await engine.maps.setPhotorealTiles(null);
          ensure(
            engine.picker.pick(centre())?.id !== 'tiles-drape',
            'tiles drape picked on terrain',
          );
          await engine.maps.setPhotorealTiles(mapSources.photoreal);
          ensure(
            engine.picker.pick(centre())?.id === 'tiles-drape',
            'tiles drape missed tiles',
          );
        } finally {
          set.destroy();
          await engine.maps.setPhotorealTiles(null);
        }
      },
    ]);
  return checks;
}
