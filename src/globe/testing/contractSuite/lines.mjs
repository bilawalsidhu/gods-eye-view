import { cartesian3, math, show, ensure, near, along } from './helpers.mjs';

export function lineChecks(
  engine,
  { settle, until, nadirView, centre, readRegion, pointer },
) {
  return [
    [
      'lines.createLine: a line draws between its projections, turns with its model matrix and dims where hidden',
      async () => {
        await nadirView(1e6);
        // 20 km up: above any ground the scene draws.
        const at = (lon, lat, height = 20_000) =>
          cartesian3.fromDegrees(lon, lat, height);
        const line = engine.lines.createLine({
          id: 'contract-line',
          widthPx: 8,
          color: [1, 0, 1, 1],
        });
        const hidden = engine.lines.createLine({
          id: 'contract-line-hidden',
          widthPx: 10,
          color: [1, 0, 1, 1],
          depthFailAlpha: 0.6,
        });
        try {
          line.setPositions([at(19, 9), at(20, 9), at(21, 9)]);
          ensure(
            engine.lines
              .list()
              .some(({ id, points }) => id === 'contract-line' && points === 3),
            'lines.list() does not show the line',
          );
          if (!readRegion) return;
          // Magenta-leaning pixels (red and blue over green; a dimmed copy
          // over a light map stays above 30) near a point.
          // The strongest magenta lean near a point (for dimmer-than).
          const strength = (position) => {
            const screen = engine.projector.worldToWindow(position);
            const data = readRegion(
              Math.round(screen.x) - 6,
              Math.round(screen.y) - 6,
              12,
              12,
            );
            let best = -255;
            for (let i = 0; i < data.length; i += 4)
              best = Math.max(
                best,
                Math.min(data[i], data[i + 2]) - data[i + 1],
              );
            return best;
          };
          const magentaAt = (position) => {
            const screen = engine.projector.worldToWindow(position);
            if (!screen) return 0;
            const data = readRegion(
              Math.round(screen.x) - 6,
              Math.round(screen.y) - 6,
              12,
              12,
            );
            let count = 0;
            for (let i = 0; i < data.length; i += 4)
              if (
                Math.min(data[i], data[i + 2]) - data[i + 1] > 30 &&
                data[i] > 120
              )
                count++;
            return count;
          };
          await until(
            () => magentaAt(at(19.5, 9)) > 10 && magentaAt(at(20.5, 9)) > 10,
            'the line drawn along both segments',
          );
          ensure(magentaAt(at(19.5, 10.5)) === 0, 'line pixels off the line');
          // Turned 1° about the Earth's axis: the line moves 1° east.
          const turn = (radians) => {
            const c = Math.cos(radians);
            const s = Math.sin(radians);
            return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
          };
          line.setModelMatrix(turn(math.toRadians(1)));
          await until(
            () => magentaAt(at(21.5, 9)) > 10 && magentaAt(at(19.25, 9)) === 0,
            'the turned line drawn 1° east',
          );
          const shownStrength = strength(at(20.5, 9));
          line.show(false);
          await until(() => magentaAt(at(20.5, 9)) === 0, 'the line hidden');
          // Round the back of the Earth along the great circle west of the
          // view centre, out to a visible end past the western horizon. The
          // far side, behind the Earth's centre, shows only by its dimmed
          // depth-fail copy. Cesium culls a line the globe hides whole, and
          // draws in full what lies under the horizon but before the centre.
          const west = (degrees) => {
            const t = (degrees * Math.PI) / 180;
            const [lon0, lat0] = [(20 * Math.PI) / 180, (10 * Math.PI) / 180];
            const [x, y, z] = [
              Math.cos(lat0) * Math.cos(lon0) * Math.cos(t) +
                Math.sin(lon0) * Math.sin(t),
              Math.cos(lat0) * Math.sin(lon0) * Math.cos(t) -
                Math.cos(lon0) * Math.sin(t),
              Math.sin(lat0) * Math.cos(t),
            ];
            return at(
              (Math.atan2(y, x) * 180) / Math.PI,
              (Math.asin(z) * 180) / Math.PI,
            );
          };
          const deep = () => west(150);
          hidden.setPositions([200, 150, 100, 50, 20].map(west));
          await until(
            () => magentaAt(deep()) > 10,
            'the hidden line drawn by its depth-fail copy',
          );
          const hiddenStrength = strength(deep());
          ensure(
            hiddenStrength < shownStrength,
            `the depth-fail copy (${hiddenStrength}) is not dimmer than the line (${shownStrength})`,
          );
          hidden.destroy();
          await until(() => magentaAt(deep()) === 0, 'the destroyed line gone');
        } finally {
          line.destroy();
          hidden.destroy();
        }
        ensure(
          !engine.lines.list().some(({ id }) => id.startsWith('contract-line')),
          'a destroyed line is still listed',
        );
      },
    ],
    [
      'lines.createLine: batched segments stay disconnected and retain individual picks',
      async () => {
        await nadirView(1e6);
        const at = (lon, lat) => cartesian3.fromDegrees(lon, lat, 20_000);
        const id = 'contract-segments';
        const batch = engine.lines.createSegments({
          id,
          widthPx: 10,
          color: [1, 0, 1, 1],
        });
        const screen = (lon, lat) =>
          engine.projector.worldToWindow(at(lon, lat));
        const pick = (lon, lat) => engine.picker.pick(screen(lon, lat));
        const magenta = (lon, lat) => {
          const p = screen(lon, lat);
          const pixels = readRegion(
            Math.round(p.x) - 5,
            Math.round(p.y) - 5,
            10,
            10,
          );
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (Math.min(pixels[i], pixels[i + 2]) - pixels[i + 1] > 30)
              count++;
          return count;
        };
        try {
          batch.replace([
            { positions: [at(19, 9.5), at(19, 10.5)], pickId: 'west' },
            {
              positions: [at(21, 9.5), at(21, 10.5)],
              widthPx: 12,
              pickId: 'east',
            },
            { positions: [at(20, 10.8), at(20, 11.2)] },
          ]);
          batch.commit();
          ensure(
            engine.lines.list().find((entry) => entry.id === id)?.points === 6,
            'batch endpoints',
          );
          if (!pointer && !readRegion) return;
          await until(
            () => pick(19, 10)?.id === 'west' && pick(21, 10)?.id === 'east',
            'both segment picks',
          );
          ensure(pick(19, 10)?.owner === id, 'batch pick owner');
          ensure(
            pick(20, 11)?.owner !== id,
            'segment without a pick id is ignored',
          );
          ensure(pick(20, 10)?.owner !== id, 'no connecting segment pick');
          if (readRegion) {
            await until(
              () => magenta(19, 10) > 10 && magenta(21, 10) > 10,
              'both segments drawn',
            );
            ensure(magenta(20, 10) === 0, 'no connecting segment pixels');
          }
          batch.show(false);
          await settle(3);
          ensure(pick(19, 10)?.owner !== id, 'hidden batch is not picked');
          batch.replace([
            { positions: [at(21, 9.5), at(21, 10.5)], pickId: 'replacement' },
          ]);
          batch.commit();
          await settle(3);
          ensure(pick(21, 10)?.owner !== id, 'replacement stays hidden');
          batch.show(true);
          await until(
            () => pick(21, 10)?.id === 'replacement',
            'replacement pick',
          );
          ensure(pick(19, 10)?.owner !== id, 'removed segment is not picked');
          batch.replace([]);
          batch.commit();
          await settle(3);
          ensure(pick(21, 10)?.owner !== id, 'empty batch is not picked');
        } finally {
          batch.destroy();
          batch.destroy();
        }
        ensure(
          !engine.lines.list().some((entry) => entry.id === id),
          'batch released',
        );
      },
    ],
  ];
}

export function dashChecks(engine, { until, nadirView, readRegion }) {
  return [
    [
      'lines.createLine: pixel dashes are regular, in CSS pixels',
      async () => {
        if (!readRegion) return;
        await nadirView(1e6);
        const line = engine.lines.createLine({
          id: 'contract-dashes',
          widthPx: 6,
          color: [1, 0, 1, 1],
          dash: { lengthPx: 16, gapPx: 16 },
        });
        try {
          const a = cartesian3.fromDegrees(19, 9, 20_000);
          const b = cartesian3.fromDegrees(21, 9, 20_000);
          line.setPositions([a, b]);
          const sa = engine.projector.worldToWindow(a);
          const sb = engine.projector.worldToWindow(b);
          // On/off runs (CSS px) along the middle of the line.
          const runs = () => {
            const left = Math.round(Math.min(sa.x, sb.x)) + 4;
            const width = Math.round(Math.abs(sb.x - sa.x)) - 8;
            const y = Math.round((sa.y + sb.y) / 2);
            const data = readRegion(left, y, width, 1);
            const on = [];
            const off = [];
            let current = null;
            let length = 0;
            for (let x = 0; x < width; x++) {
              const i = x * 4;
              const lit =
                Math.min(data[i], data[i + 2]) - data[i + 1] > 60 &&
                data[i] > 150;
              if (lit === current) length++;
              else {
                if (current !== null) (current ? on : off).push(length);
                current = lit;
                length = 1;
              }
            }
            // The first and last runs are cut by the window.
            return { on: on.slice(1), off: off.slice(1) };
          };
          const median = (values) =>
            [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
          await until(() => runs().on.length >= 3, 'dashes drawn');
          const { on, off } = runs();
          const spread = (values) => Math.max(...values) - Math.min(...values);
          // What each engine draws for 16/16, for the harness to compare
          // across device pixel ratios (Cesium's PolylineDash is the
          // reference; Navara's must not change with the ratio).
          globalThis.__qaDashes = {
            dash: median(on),
            gap: median(off),
            period: median(on) + median(off),
          };
          ensure(
            on.length >= 3 && spread(on) <= 2 && spread(off) <= 2,
            `irregular dashes: runs ${JSON.stringify(on)} / ${JSON.stringify(off)}`,
          );
          if (engine.kind === 'navara')
            ensure(
              Math.abs(median(on) - 16) <= 2 && Math.abs(median(off) - 16) <= 2,
              `dash ${median(on)} px, gap ${median(off)} px (16/16 asked)`,
            );
        } finally {
          line.destroy();
        }
      },
    ],
  ];
}
