// The model field drawn through the renderer's ports: globe imagery on the
// globe, the draw port's raster shell over photorealistic 3D tiles.
import { findDraw } from '../../render/rendererOf.js';
import { WEATHER_IMAGERY_Z } from '../weather/imageryOrder.js';
import {
  followShellLift,
  WEATHER_SHELL_HEIGHTS,
} from '../weather/shellPlacement.js';

let shells = 0;

/** One painted image (`field.js` `paintField`) on a canvas, or null without a page. */
function canvasFor({ width, height, rgba }) {
  const canvas = globalThis.document?.createElement?.('canvas');
  const context = canvas?.getContext?.('2d');
  if (!context) return null;
  canvas.width = width;
  canvas.height = height;
  const pixels = context.createImageData(width, height);
  pixels.data.set(rgba);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * The colour field on whichever surface the map shows, as wind's colour
 * field is: one `single-image` imagery layer per image on the globe, in the
 * weather imagery's order, or over 3D tiles a raised shell per image that
 * rises with the camera. The images are drawn in order, the Europe inset
 * over the global field.
 * @param {{getViewer: () => object | null, getHost: () => {collection: object | null, kind: string}}} options
 */
export function createFieldDrawing({ getViewer, getHost }) {
  let handles = [];
  let shownKey = null;
  /** The last painted images, by their key, so a new host draws them again unpainted. */
  let painted = null;
  const remove = () => {
    for (const dispose of handles.splice(0)) dispose();
    shownKey = null;
  };
  return {
    remove,
    /**
     * Draw the images `paint()` returns, known by `key`: the same key on the
     * same host keeps what is drawn, without painting again.
     * @returns {boolean} Whether the field is drawn.
     */
    show(key, paint) {
      const viewer = getViewer();
      const host = getHost();
      const hostKey = `${key}|${host?.kind}`;
      if (hostKey === shownKey) return true;
      remove();
      if (!viewer || !host || host.kind === 'none') return false;
      const draw = host.kind === 'tileset' ? findDraw(viewer) : null;
      if (host.kind === 'tileset' ? !draw?.field : !host.collection?.add)
        return false;
      if (painted?.key !== key) {
        const canvases = paint().map((image) => ({
          ...image,
          canvas: canvasFor(image),
        }));
        painted = { key, canvases };
      }
      if (painted.canvases.some(({ canvas }) => !canvas)) return false;
      painted.canvases.forEach(({ name, canvas, rectangle }, index) => {
        if (host.kind === 'tileset') {
          const seq = (shells += 1);
          const field = draw.field({
            kind: 'rasterShell',
            id: `air-quality-shell:${name}:${seq}`,
            image: { canvas, key: `air-quality-shell:${name}:${seq}` },
            rectangle,
            // The inset a little above the global field, so it draws over it.
            heightM: WEATHER_SHELL_HEIGHTS.wind + index * 150,
            alpha: 1,
          });
          const offLift = followShellLift(viewer, (liftM) =>
            field.update({ liftM }),
          );
          handles.push(() => {
            offLift();
            field.dispose();
          });
          return;
        }
        const imagery = host.collection.add({
          kind: 'single-image',
          url: canvas.toDataURL('image/png'),
          rectangle,
          zOrder: WEATHER_IMAGERY_Z.wind,
        });
        imagery.drapeOn = 'surface';
        // Each pixel carries its own opacity.
        imagery.alpha = 1;
        handles.push(() => imagery.remove());
      });
      shownKey = hostKey;
      return true;
    },
    /** Let go of what is drawn and of the painted images. */
    dispose() {
      remove();
      painted = null;
    },
  };
}
