import {
  ellipsoid,
  throwsType,
  MAGENTA,
  GREEN,
  nearColour,
  show,
  screenOf,
  meanAt,
  ensure,
} from './helpers.mjs';

export function imageryChecks(
  engine,
  { settle, until, nadirView, readRegion },
) {
  const { imagery } = engine;

  // A flat colour as RGBA bytes (no canvas needed), size × size texels.
  const flat = (rgba, size = 8) => {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    return { width: size, height: size, data };
  };
  const box = { west: 19, south: 9.5, east: 20, north: 10.5 };
  const listed = (id) => imagery.list().find((entry) => entry.id === id);
  return [
    [
      'imagery.createLayer: layers are created, listed, restyled, ordered and destroyed',
      async () => {
        const source = { kind: 'image', image: flat([255, 0, 255, 255]) };
        throwsType(
          () =>
            imagery.createLayer({ id: 'contract-bad', source: { kind: 'x' } }),
          'an unknown source kind',
        );
        throwsType(
          () =>
            imagery.createLayer({
              id: 'contract-bad',
              source: {
                kind: 'tiles',
                url: 'https://example.test/{z}/{x}.png',
              },
            }),
          'a template without {y}',
        );
        throwsType(
          () =>
            imagery.createLayer({
              id: 'contract-bad',
              source: {
                kind: 'image',
                image: { width: 2, height: 2, data: new Uint8Array(3) },
              },
            }),
          'RGBA bytes of the wrong length',
        );
        throwsType(
          () => imagery.createLayer({ id: 'contract-bad', source, alpha: 2 }),
          'an alpha above 1',
        );
        throwsType(
          () =>
            imagery.createLayer({ id: 'contract-bad', source, split: 'up' }),
          'an unknown split',
        );
        throwsType(
          () =>
            imagery.createLayer({
              id: 'contract-bad',
              source: {
                ...source,
                rectangle: { west: 0, south: 5, east: 1, north: 4 },
              },
            }),
          'a rectangle upside down',
        );
        ensure(!listed('contract-bad'), 'a refused layer is listed');
        ensure(
          ['globe', 'tiles', 'none'].includes(imagery.surface()),
          `surface() ${imagery.surface()}`,
        );
        const top = imagery.createLayer({
          id: 'contract-imagery-top',
          source,
          order: 2,
        });
        const bottom = imagery.createLayer({
          id: 'contract-imagery-bottom',
          source: {
            kind: 'image',
            image: flat([0, 255, 0, 255]),
            rectangle: box,
          },
          alpha: 0.5,
          show: false,
          split: 'left',
        });
        const split = imagery.splitPosition();
        try {
          let duplicate = null;
          try {
            imagery.createLayer({ id: 'contract-imagery-top', source });
          } catch (error) {
            duplicate = error;
          }
          ensure(duplicate, 'a second live layer with the same id');
          ensure(top.id === 'contract-imagery-top', `id ${top.id}`);
          const ids = imagery.list().map(({ id }) => id);
          ensure(
            ids.indexOf('contract-imagery-bottom') <
              ids.indexOf('contract-imagery-top'),
            `list() is not in draw order: ${ids.join(', ')}`,
          );
          ensure(
            listed('contract-imagery-bottom')?.kind === 'image' &&
              listed('contract-imagery-bottom').shown === false &&
              listed('contract-imagery-bottom').alpha === 0.5 &&
              listed('contract-imagery-bottom').split === 'left' &&
              listed('contract-imagery-top').order === 2,
            `list(): ${JSON.stringify(imagery.list())}`,
          );
          ensure(
            bottom.shown() === false &&
              bottom.alpha() === 0.5 &&
              bottom.split() === 'left',
            'the options are not the layer state',
          );
          bottom.show(true);
          bottom.setAlpha(0.25);
          bottom.setSplit('right');
          ensure(
            bottom.shown() === true &&
              bottom.alpha() === 0.25 &&
              bottom.split() === 'right' &&
              listed('contract-imagery-bottom').alpha === 0.25,
            'a restyle is not reported',
          );
          throwsType(() => bottom.setAlpha(-1), 'a negative alpha');
          throwsType(() => bottom.setSplit('down'), 'an unknown side');
          throwsType(
            () => bottom.setSource({ kind: 'image' }),
            'an empty source',
          );
          ensure(
            bottom.source().kind === 'image',
            'a refused source replaced it',
          );
          bottom.setSource({
            kind: 'tiles',
            url: 'https://tiles.invalid/{z}/{x}/{y}.png',
            maxLevel: 3,
            rectangle: box,
          });
          ensure(
            bottom.source().kind === 'tiles' &&
              listed('contract-imagery-bottom').kind === 'tiles',
            'setSource() did not replace the source',
          );
          imagery.setSplitPosition(0.25);
          ensure(imagery.splitPosition() === 0.25, 'the split position');
          throwsType(
            () => imagery.setSplitPosition(1.5),
            'a split outside 0..1',
          );
          await until(() => top.ready(), 'the image layer ready');
          await settle();
        } finally {
          imagery.setSplitPosition(split);
          top.destroy();
          bottom.destroy();
        }
        ensure(!listed('contract-imagery-top'), 'a destroyed layer is listed');
        ensure(!top.ready(), 'a destroyed layer is ready');
        top.destroy();
        let refused = null;
        try {
          top.setAlpha(1);
        } catch (error) {
          refused = error;
        }
        ensure(refused, 'a destroyed layer took a restyle');
      },
    ],
    [
      'imagery.createLayer: images draw on the ground by alpha, show, order and split (pixels)',
      async () => {
        if (!readRegion) return;
        await nadirView(1e6);
        // The mean colour in a box centred on a ground point.

        // The map's own tiles loaded: what lies under the layers holds still.
        await until(() => engine.surface.tilesLoaded(), 'the map tiles loaded');
        await settle(4);
        const base = meanAt(engine, readRegion, 19.5, 10, 6);
        ensure(
          !nearColour(base, MAGENTA),
          'the globe is already magenta there',
        );
        const magenta = imagery.createLayer({
          id: 'contract-paint-magenta',
          source: {
            kind: 'image',
            image: flat([...MAGENTA, 255]),
            rectangle: box,
          },
        });
        const layers = [magenta];
        try {
          await until(() => magenta.ready(), 'the magenta layer ready');
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 6), MAGENTA),
            'the magenta layer drawn',
          );
          ensure(
            nearColour(meanAt(engine, readRegion, 21, 10, 6), base, 60) ||
              !nearColour(meanAt(engine, readRegion, 21, 10, 6), MAGENTA),
            'the layer spills outside its rectangle',
          );
          // Alpha: at 0 the globe under it, at 0.5 half way to magenta.
          magenta.setAlpha(0);
          await until(
            () => !nearColour(meanAt(engine, readRegion, 19.5, 10, 6), MAGENTA),
            'alpha 0 drawn',
          );
          await settle(2);
          const below = meanAt(engine, readRegion, 19.5, 10, 6);
          magenta.setAlpha(0.5);
          const half = below.map((value, k) => (value + MAGENTA[k]) / 2);
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 6), half, 30),
            `alpha 0.5 drawn (${show(half)} wanted)`,
          );
          magenta.setAlpha(1);
          magenta.show(false);
          await until(
            () =>
              nearColour(meanAt(engine, readRegion, 19.5, 10, 6), below, 30),
            'the hidden layer gone',
          );
          magenta.show(true);
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 6), MAGENTA),
            'the layer shown again',
          );
          // Order: a higher order draws on top, a lower one under it.
          const green = imagery.createLayer({
            id: 'contract-paint-green',
            source: {
              kind: 'image',
              image: flat([...GREEN, 255]),
              rectangle: box,
            },
            order: 1,
          });
          layers.push(green);
          const lower = imagery.createLayer({
            id: 'contract-paint-under',
            source: {
              kind: 'image',
              image: flat([0, 255, 255, 255]),
              rectangle: box,
            },
            order: -1,
          });
          layers.push(lower);
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 6), GREEN),
            'the higher order on top',
          );
          green.destroy();
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 6), MAGENTA),
            'the destroyed layer gone',
          );
          // A new source in place: the same layer, another colour.
          magenta.setSource({
            kind: 'image',
            image: flat([...GREEN, 255]),
            rectangle: box,
          });
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 6), GREEN),
            'the new source drawn',
          );
          magenta.setSource({
            kind: 'image',
            image: flat([...MAGENTA, 255]),
            rectangle: box,
          });
          lower.destroy();
          // Split: a left layer draws only left of the split position.
          const width = engine.host.size().width;
          const middle = screenOf(engine, 19.5, 10).x;
          imagery.setSplitPosition(middle / width);
          magenta.setSplit('left');
          const left = screenOf(engine, 19.25, 10);
          const right = screenOf(engine, 19.75, 10);
          const at = ({ x, y }) => {
            const data = readRegion(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
            const mean = [0, 0, 0];
            for (let i = 0; i < data.length; i += 4)
              for (let k = 0; k < 3; k++) mean[k] += data[i + k] / 36;
            return mean;
          };
          await until(
            () =>
              nearColour(at(left), MAGENTA) && !nearColour(at(right), MAGENTA),
            `the left split drawn (left ${show(at(left))}, right ${show(at(right))})`,
          );
          magenta.setSplit('right');
          await until(
            () =>
              !nearColour(at(left), MAGENTA) && nearColour(at(right), MAGENTA),
            'the right split drawn',
          );
          magenta.setSplit('none');
          await until(
            () =>
              nearColour(at(left), MAGENTA) && nearColour(at(right), MAGENTA),
            'the unsplit layer drawn',
          );
        } finally {
          imagery.setSplitPosition(0.5);
          for (const layer of layers) layer.destroy();
        }
        await until(
          () =>
            [MAGENTA, GREEN, [0, 255, 255]].every(
              (colour) =>
                !nearColour(meanAt(engine, readRegion, 19.5, 10, 6), colour),
            ),
          'every layer gone',
        );
      },
    ],
    [
      'imagery.createLayer: tile schemes, transforms, staged sources and raised layers are checked and kept',
      async () => {
        const magenta = { kind: 'image', image: flat([255, 0, 255, 255]) };
        const green = { kind: 'image', image: flat([0, 255, 0, 255]) };
        const template = {
          kind: 'tiles',
          url: 'https://tiles.invalid/{z}/{x}/{y}.png',
          maxLevel: 3,
          rectangle: box,
        };
        throwsType(
          () =>
            imagery.createLayer({
              id: 'contract-bad',
              source: { ...template, scheme: 'polar' },
            }),
          'an unknown tile scheme',
        );
        throwsType(
          () =>
            imagery.createLayer({
              id: 'contract-bad',
              source: { ...template, transform: 'mask' },
            }),
          'a transform that is not a function',
        );
        throwsType(
          () =>
            imagery.createLayer({
              id: 'contract-bad',
              source: magenta,
              raise: -1,
            }),
          'a raise below the ellipsoid',
        );
        throwsType(
          () =>
            imagery.createLayer({
              id: 'contract-bad',
              source: template,
              raise: 6000,
            }),
          'a raised tiles layer',
        );
        ensure(!listed('contract-bad'), 'a refused layer is listed');
        const geographic = imagery.createLayer({
          id: 'contract-imagery-geographic',
          source: { ...template, scheme: 'geographic', transform: (i) => i },
        });
        const staged = imagery.createLayer({
          id: 'contract-imagery-staged',
          source: { ...magenta, rectangle: box },
        });
        const raisedLayer = imagery.createLayer({
          id: 'contract-imagery-raised',
          source: { ...magenta, rectangle: box },
          raise: 6000,
        });
        // A promise's outcome, read frame by frame.
        const outcome = (promise) => {
          const result = { value: undefined };
          promise.then((value) => (result.value = value));
          return result;
        };
        try {
          ensure(
            geographic.source().scheme === 'geographic' &&
              typeof geographic.source().transform === 'function',
            'the tile scheme or transform is not kept',
          );
          ensure(
            listed('contract-imagery-raised') &&
              raisedLayer.raise() === 6000 &&
              staged.raise() === null,
            `raise(): ${raisedLayer.raise()}, ${staged.raise()}`,
          );
          throwsType(
            () => staged.setDetail({ image: flat([0, 0, 0, 255]) }),
            'a detail on a draped layer',
          );
          throwsType(
            () => raisedLayer.setSource(template),
            'tiles on a raised layer',
          );
          throwsType(
            () =>
              raisedLayer.setDetail({
                image: flat([0, 0, 0, 255]),
                rectangle: { west: 170, south: 0, east: -170, north: 1 },
              }),
            'a detail across the antimeridian',
          );
          // Staged: the drawn source stays until the new one is drawn.
          await until(() => staged.ready(), 'the staged layer ready');
          const first = outcome(
            staged.setSource({ ...green, rectangle: box }, { staged: true }),
          );
          ensure(
            staged.source().image === magenta.image ||
              first.value === true ||
              staged.source().image === green.image,
            'a staged source replaced nothing',
          );
          await until(() => first.value !== undefined, 'the staged source');
          ensure(first.value === true, 'the staged source failed');
          ensure(
            staged.source().image === green.image && !staged.staging(),
            'the staged source is not the layer source',
          );
          // A newer source wins; an aborted one leaves the drawn source.
          const superseded = outcome(
            staged.setSource({ ...magenta, rectangle: box }, { staged: true }),
          );
          const winner = outcome(
            staged.setSource(
              { kind: 'image', image: flat([0, 0, 255, 255]), rectangle: box },
              { staged: true },
            ),
          );
          await until(
            () => superseded.value !== undefined && winner.value !== undefined,
            'the superseded and the newer staged sources',
          );
          ensure(
            superseded.value === false && winner.value === true,
            `superseded ${superseded.value}, newer ${winner.value}`,
          );
          const drawnImage = staged.source().image;
          const controller = new AbortController();
          const aborted = outcome(
            staged.setSource(
              { ...magenta, rectangle: box },
              { staged: true, signal: controller.signal },
            ),
          );
          controller.abort();
          await until(() => aborted.value !== undefined, 'the aborted source');
          ensure(
            aborted.value === false && staged.source().image === drawnImage,
            'an aborted staged source replaced the drawn one',
          );
          // A new credit alone keeps the source's pixels.
          geographic.setSource({
            ...template,
            scheme: 'geographic',
            transform: geographic.source().transform,
            credit: 'Contract credit',
          });
          ensure(
            geographic.source().credit === 'Contract credit',
            'the credit did not change',
          );
          // A hidden layer takes a staged source at once.
          staged.show(false);
          const hidden = outcome(
            staged.setSource({ ...green, rectangle: box }, { staged: true }),
          );
          await until(() => hidden.value !== undefined, 'the hidden staged');
          ensure(hidden.value === true, 'a hidden layer refused a stage');
          // A raised layer's detail.
          const west = { ...box, east: 19.5 };
          await until(() => raisedLayer.ready(), 'the raised layer drawn');
          const detail = outcome(
            raisedLayer.setDetail({
              image: flat([0, 255, 0, 255]),
              rectangle: west,
            }),
          );
          await until(() => detail.value !== undefined, 'the detail drawn');
          ensure(
            detail.value === true &&
              raisedLayer.detail()?.rectangle.east === 19.5,
            'the detail is not kept',
          );
          await raisedLayer.setDetail(null);
          ensure(raisedLayer.detail() === null, 'the detail is not cleared');
        } finally {
          geographic.destroy();
          staged.destroy();
          raisedLayer.destroy();
        }
        ensure(!listed('contract-imagery-raised'), 'a raised layer is listed');
      },
    ],
    [
      'imagery.createLayer: geographic tiles through a transform, staged and raised layers draw (pixels)',
      async () => {
        if (!readRegion) return;
        await nadirView(1e6);

        await until(() => engine.surface.tilesLoaded(), 'the map tiles loaded');
        await settle(4);
        // Every tile, whatever the app serves, painted magenta by the
        // transform: geographic tiles over the box only.
        const painted = (image) => {
          const size = image.width;
          const data = new Uint8Array(size * size * 4);
          for (let i = 0; i < data.length; i += 4)
            data.set([255, 0, 255, 255], i);
          if (typeof document === 'undefined') return image;
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const context = canvas.getContext('2d');
          const pixels = context.createImageData(size, size);
          pixels.data.set(data);
          context.putImageData(pixels, 0, 0);
          return canvas;
        };
        const layers = [];
        try {
          const tiles = imagery.createLayer({
            id: 'contract-paint-geographic',
            source: {
              kind: 'tiles',
              url: '/icons/icon-32.png?z={z}&x={x}&y={y}',
              tileSize: 32,
              maxLevel: 4,
              scheme: 'geographic',
              transform: painted,
              rectangle: box,
            },
          });
          layers.push(tiles);
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 5), MAGENTA),
            `the transformed tiles drawn (${show(meanAt(engine, readRegion, 19.5, 10, 5))})`,
          );
          ensure(
            !nearColour(meanAt(engine, readRegion, 21, 10, 5), MAGENTA),
            'the tiles spill outside their rectangle',
          );
          // Staged: green replaces the magenta tiles once it is drawn.
          const staged = tiles.setSource(
            { kind: 'image', image: flat([...GREEN, 255]), rectangle: box },
            { staged: true },
          );
          let swapped;
          staged.then((value) => (swapped = value));
          await until(() => swapped !== undefined, 'the staged image');
          ensure(swapped === true, 'the staged image failed');
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.5, 10, 5), GREEN),
            `the staged image drawn (${show(meanAt(engine, readRegion, 19.5, 10, 5))})`,
          );
          tiles.destroy();
          // Raised 6 km: drawn over the box (a little parallax at 1000 km),
          // a detail in place of its west half.
          const raisedLayer = imagery.createLayer({
            id: 'contract-paint-raised',
            source: {
              kind: 'image',
              image: flat([...MAGENTA, 255]),
              rectangle: box,
            },
            raise: 6000,
          });
          layers.push(raisedLayer);
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.6, 10, 5), MAGENTA),
            `the raised layer drawn (${show(meanAt(engine, readRegion, 19.6, 10, 5))})`,
          );
          raisedLayer.setDetail({
            image: flat([...GREEN, 255]),
            rectangle: { ...box, east: 19.5 },
          });
          await until(
            () =>
              nearColour(meanAt(engine, readRegion, 19.25, 10, 5), GREEN) &&
              nearColour(meanAt(engine, readRegion, 19.75, 10, 5), MAGENTA),
            `the detail drawn (west ${show(meanAt(engine, readRegion, 19.25, 10, 5))}, east ${show(meanAt(engine, readRegion, 19.75, 10, 5))})`,
          );
          raisedLayer.setDetail(null);
          await until(
            () => nearColour(meanAt(engine, readRegion, 19.25, 10, 5), MAGENTA),
            'the detail cleared',
          );
        } finally {
          for (const layer of layers) layer.destroy();
        }
        await until(
          () =>
            !nearColour(meanAt(engine, readRegion, 19.5, 10, 5), MAGENTA) &&
            !nearColour(meanAt(engine, readRegion, 19.5, 10, 5), GREEN),
          'every layer gone',
        );
      },
    ],
  ];
}

export function imageryBehaviourChecks(
  engine,
  { until, settle, nadirView, readRegion, resize, makeCanvas },
) {
  const source = {
    kind: 'image',
    image: { width: 1, height: 1, data: new Uint8Array([51, 153, 102, 255]) },
    rectangle: { west: 19, south: 9, east: 21, north: 11 },
  };
  const checks = [
    [
      'imagery.createLayer: an imagery pixel draws as asked within 10 per channel',
      async () => {
        await nadirView(10000);
        const layer = engine.imagery.createLayer({
          id: 'contract-imagery-colour',
          source,
        });
        try {
          await until(() => layer.ready(), 'imagery colour ready');
          if (readRegion)
            await until(
              () =>
                nearColour(
                  meanAt(engine, readRegion, 20, 10, 2),
                  [51, 153, 102],
                  10,
                ),
              'imagery colour within 10 per channel',
            );
        } finally {
          layer.destroy();
        }
      },
    ],
  ];
  if (resize)
    checks.push([
      'imagery.createLayer: resize replans the visible tiles',
      async () => {
        const previous = engine.host.size();
        let layer;
        const drawn = () => {
          const { width, height } = engine.host.size();
          return [0.1, 0.9].every((fraction) => {
            const pixel = readRegion(
              Math.round(width * fraction),
              Math.round(height / 2),
              1,
              1,
            );
            return nearColour(
              Array.from(pixel).slice(0, 3),
              [51, 153, 102],
              10,
            );
          });
        };
        try {
          await resize(400, 800);
          await nadirView(1e6);
          layer = engine.imagery.createLayer({
            id: 'contract-imagery-resize',
            source: makeCanvas
              ? {
                  kind: 'tiles',
                  url: '/icons/icon-32.png?contract={z}/{x}/{y}',
                  tileSize: 32,
                  maxLevel: 8,
                  transform: () => {
                    const canvas = makeCanvas(32, 32);
                    const context = canvas.getContext('2d');
                    context.fillStyle = '#339966';
                    context.fillRect(0, 0, 32, 32);
                    return canvas;
                  },
                }
              : source,
          });
          await until(() => layer.ready(), 'imagery before resize');
          if (readRegion) await until(drawn, 'imagery drawn before resize');
          await resize(1280, 800);
          await until(() => {
            const { width, height } = engine.host.size();
            return width === 1280 && height === 800;
          }, 'the resized canvas size');
          await settle(4);
          await until(() => layer.ready(), 'imagery after resize');
          // A ready provider or transformed tile need not have drawn yet.
          // The wider view must gain coverage on both sides, cached or new.
          if (readRegion) await until(drawn, 'imagery drawn after resize');
        } finally {
          layer?.destroy();
          await resize(previous.width, previous.height);
        }
      },
    ]);
  return checks;
}
