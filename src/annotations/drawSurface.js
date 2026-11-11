import * as geo from '../geo/index.js';
import { pickWorldFromScreen } from './annotationResolver.js';
import { DRAW_COLOR_CSS } from './drawMarks.js';
import { MAX_VERTICES } from './drawMode.js';

const LINE_ID = 'gev-draw-preview';
const DOTS_ID = 'gev-draw-vertices';

/** '#rrggbb' → rgba in 0..1. */
function cssRgba(css, alpha = 1) {
  const hex = Number.parseInt(String(css).slice(1), 16);
  return [
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
    alpha,
  ];
}

const world = (v) => geo.cartesian3.fromDegrees(v.lon, v.lat, v.height || 0);

/**
 * The draw surface factory for `engine`: `surface({ session, cursor })`
 * (the open shape and the rubber band's end, as live getters) returns the
 * input and preview initDrawTool runs on.
 * @param {import('../globe/contract.js').GlobeEngine} engine
 */
export function createDrawSurface(engine) {
  return (live) => {
    let line = null;
    let dots = null;
    let removers = null;
    let color = 'primary';
    let destroyed = false;

    const ensurePreview = () => {
      line ??= engine.lines.createLine({
        id: LINE_ID,
        widthPx: 3,
        arc: 'geodesic',
        color: cssRgba(DRAW_COLOR_CSS.primary, 0.9),
        // Cesium's depth-fail dash at 0.35 of the colour, 0.9 in front.
        depthFailAlpha: 0.35 / 0.9,
        dash: { lengthPx: 8, gapPx: 8 },
      });
      dots ??= engine.movers.createSet({
        id: DOTS_ID,
        kind: 'point',
        capacity: MAX_VERTICES,
        order: 10,
        depthTest: 'always',
        pickable: false,
        point: { sizePx: 8, outlinePx: 2, outlineColor: [0, 0, 0, 0.6] },
      });
    };
    /** The rubber band through the vertices, the pointer and back (areas). */
    const drawLine = () => {
      const session = live.session();
      if (!line) return;
      if (!session || session.shape === 'pin') {
        line.show(false);
        return;
      }
      const points = session.vertices.map(world);
      const cursor = live.cursor();
      if (cursor) points.push(world(cursor));
      if (session.shape === 'area' && points.length >= 3)
        points.push(points[0]);
      if (points.length < 2) {
        line.show(false);
        return;
      }
      line.setPositions(points);
      line.show(true);
    };

    return {
      canvas: engine.host.canvas,
      pick(position) {
        const { width, height } = engine.host.size();
        return pickWorldFromScreen(
          engine,
          position.x / (width || 1),
          position.y / (height || 1),
        );
      },
      sync(session, nextColor) {
        if (destroyed) return;
        color = nextColor;
        if (!session) {
          line?.show(false);
          if (dots) {
            dots.setCount(0);
            dots.commit();
          }
          engine.render.request('draw');
          return;
        }
        ensurePreview();
        const css = DRAW_COLOR_CSS[color] || DRAW_COLOR_CSS.primary;
        line.setColor(cssRgba(css, 0.9));
        const stroke = cssRgba(css, 1);
        session.vertices.forEach((v, index) =>
          dots.set(index, { position: world(v), color: stroke, show: true }),
        );
        dots.setCount(session.vertices.length);
        dots.commit();
        drawLine();
        engine.render.request('draw');
      },
      moved() {
        if (destroyed) return;
        drawLine();
        engine.render.request('draw');
      },
      bound: () => Boolean(removers),
      bind({ click, move, doubleClick }, pointer) {
        if (removers || destroyed) return;
        removers = [
          engine.input.on('click', click, { pointer }),
          engine.input.on('move', move, { pointer }),
          engine.input.on('doubleClick', doubleClick, { pointer }),
        ];
      },
      unbind() {
        for (const remove of removers ?? []) remove();
        removers = null;
      },
      diagnostics: ({ destroyed: toolDestroyed }) => ({
        sceneHandler: Boolean(removers),
        // One line and one dot per vertex.
        previewDataSources: 0,
        previewEntities: toolDestroyed
          ? 0
          : (line ? 1 : 0) + (dots ? dots.count() : 0),
        previewLines: engine.lines.list().filter(({ id }) => id === LINE_ID)
          .length,
      }),
      settled: () => Promise.resolve(),
      destroy() {
        if (!destroyed) {
          destroyed = true;
          for (const remove of removers ?? []) remove();
          removers = null;
          line?.destroy();
          dots?.destroy();
          line = dots = null;
          engine.render.request('draw');
        }
        return Promise.resolve();
      },
    };
  };
}
