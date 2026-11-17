/**
 * @module replay/overlays
 * @description The map furniture of replay, drawn through the renderer's draw
 * port: the watched areas (a tinted box with a dashed edge), the area replay
 * is limited to, and a searched contact's whole path with its first and last
 * fix and the gaps in it. None of it takes part in picks.
 */
import { drawOf } from '../render/rendererOf.js';
import { ecefOf } from './sampling.js';
import { t } from '../i18n/index.js';

export const FENCE_COLOR = '#8be9ff';
export const REGION_COLOR = '#ffb000';

/** `#rrggbb` with an alpha 0..1 as a CSS colour. */
export const withAlpha = (hex, alpha) =>
  `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;

/** A box as a rectangle; one that crosses the date line has its east past 180. */
const rectOf = (b) => ({
  west: b.west,
  south: b.south,
  east: b.west <= b.east ? b.east : b.east + 360,
  north: b.north,
});

const flat = (id, rect, color) => ({
  id,
  geometry: { kind: 'rectangle', rect },
  fill: color,
  height: 'clampGround',
  clampTo: 'both',
});

/** @param {object} viewer The scene the replay draws on. */
export function createOverlays(viewer) {
  const draw = drawOf(viewer);
  const quiet = { pickable: false };
  const fences = draw.shapes({ id: 'replay-fences', ...quiet });
  const fenceEdges = draw.lines({ id: 'replay-fence-edges', ...quiet });
  const region = draw.shapes({ id: 'replay-region', ...quiet });
  const path = draw.lines({ id: 'replay-track', ...quiet });
  const ends = draw.points({ id: 'replay-track-ends', ...quiet });

  return {
    setFences(list) {
      fences.set(
        list.map((f) =>
          flat(`replay-fence:${f.id}`, rectOf(f), withAlpha(FENCE_COLOR, 0.18)),
        ),
      );
      fenceEdges.set(
        list.map((f) => {
          const { west, south, east, north } = rectOf(f);
          return {
            id: `replay-fence-edge:${f.id}`,
            positions: [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ].map(([lon, lat]) => ecefOf({ lon, lat })),
            widthPx: 2,
            mode: 'draped',
            clampTo: 'both',
            style: {
              kind: 'dash',
              color: withAlpha(FENCE_COLOR, 0.95),
              length: 12,
            },
          };
        }),
      );
    },
    setRegion(box) {
      region.set(
        box
          ? [flat('replay-region', rectOf(box), withAlpha(REGION_COLOR, 0.1))]
          : [],
      );
    },
    /** `track` is the summary the controller keeps; `points` its recorded rows. */
    setTrack(track, points) {
      if (!track) {
        path.clear();
        ends.clear();
        return;
      }
      const lines = [
        {
          id: 'replay-track:path',
          positions: points.map(ecefOf),
          widthPx: 3,
          mode: '3d',
          style: { kind: 'solid', color: '#ffd24d' },
        },
      ];
      const byTs = new Map(points.map((p) => [p.ts, p]));
      track.gaps.forEach((gap, i) => {
        const a = byTs.get(gap.from);
        const b = byTs.get(gap.to);
        if (a && b)
          lines.push({
            id: `replay-track:gap:${i}`,
            positions: [ecefOf(a), ecefOf(b)],
            widthPx: 3,
            mode: '3d',
            style: { kind: 'dash', color: '#ff5c5c', length: 10 },
          });
      });
      path.set(lines);
      ends.set(
        [
          ['first', track.first, t('FIRST'), '#4dff9a'],
          ['last', track.last, t('LAST'), '#ff5c5c'],
        ].map(([key, p, name, color]) => ({
          id: `replay-track:${key}`,
          pos: { lon: p.lon, lat: p.lat, height: p.alt || 0 },
          pixelSize: 9,
          color,
          meta: { name },
        })),
      );
    },
    dispose() {
      for (const set of [fences, fenceEdges, region, path, ends]) set.dispose();
    },
  };
}
