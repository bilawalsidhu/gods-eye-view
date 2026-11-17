/**
 * @module replay/contacts
 * @description The replayed contacts, drawn through the renderer's draw port:
 * one point per contact placed where the recording puts it at the replay
 * time, and a trail behind it. A solid dot means a recorded fix is near; a
 * faint one means the spot is estimated between two. A contact with no
 * recording at the moment is hidden rather than bridged.
 */
import { drawOf } from '../render/rendererOf.js';
import { groupTracks } from './model.js';
import { withAlpha } from './overlays.js';
import {
  boundingSphere,
  ecefOf,
  lonLatOf,
  observedAt,
  positionAt,
  prepareTrack,
  trailAt,
} from './sampling.js';
import { positionToEcef } from '../geo/ellipsoid.js';

export const CONTACT_SET = 'replay';
const TRAIL_MS = 600 * 1000;
/** Trails are long and change slowly, so they are redrawn less often than dots. */
const TRAIL_EVERY_MS = 200;

/**
 * @param {object} viewer The scene the replay draws on.
 * @param {Record<string, string>} colors Layer id -> `#rrggbb`.
 */
export function createContacts(viewer, colors) {
  const draw = drawOf(viewer);
  const dots = draw.points({ id: CONTACT_SET });
  const trails = draw.lines({ id: 'replay-trails', pickable: false });
  /** @type {Map<string, ReturnType<typeof prepareTrack>>} */
  let tracks = new Map();
  let trailAtWall = 0;
  let drawnTrails = new Set();
  const key = (track) => `${CONTACT_SET}:${track.layer}:${track.id}`;
  const colorOf = (track) => colors[track.layer] || '#ffffff';

  function updateTrails(ms) {
    const items = [];
    const now = new Set();
    for (const track of tracks.values()) {
      const path = trailAt(track, ms, TRAIL_MS);
      if (path.length < 2) continue;
      const packed = new Float64Array(path.length * 3);
      path.forEach((p, i) => {
        const e = ecefOf(p);
        packed.set([e.x, e.y, e.z], i * 3);
      });
      now.add(key(track));
      items.push({
        id: key(track),
        positions: packed,
        widthPx: 1.5,
        mode: '3d',
        style: { kind: 'solid', color: withAlpha(colorOf(track), 0.6) },
      });
    }
    trails.upsert(items);
    const gone = [...drawnTrails].filter((id) => !now.has(id));
    if (gone.length) trails.remove(gone);
    drawnTrails = now;
  }

  return {
    /** Replace the contacts with those of these recorded rows (`layers` filters). */
    load(points, layers) {
      tracks = new Map();
      for (const track of groupTracks(points).values()) {
        if (track.points.length < 2 || !layers.has(track.layer)) continue;
        tracks.set(key(track), prepareTrack(track));
      }
      dots.clear();
      trails.clear();
      drawnTrails = new Set();
      trailAtWall = 0;
      return tracks.size;
    },
    /** Draw every contact at `ms`; `force` also redraws the trails now. */
    update(ms, force = false) {
      const items = [];
      for (const [id, track] of tracks) {
        const at = positionAt(track, ms);
        const color = colorOf(track);
        items.push({
          id,
          pos: at ? lonLatOf(at) : lonLatOf({ lon: 0, lat: 0 }),
          show: Boolean(at),
          pixelSize: 6,
          color: observedAt(track, ms) ? color : withAlpha(color, 0.15),
          outlineColor: color,
          outlineWidth: 1.5,
          meta: { layer: track.layer, id: track.id },
        });
      }
      dots.upsert(items);
      const wall = Date.now();
      if (force || wall - trailAtWall >= TRAIL_EVERY_MS) {
        trailAtWall = wall;
        updateTrails(ms);
      }
    },
    /** The contact drawn under this hit id, or null. */
    trackOf: (id) => tracks.get(id) ?? null,
    /** Where a contact is at `ms`, as ECEF, for the camera to follow; null when unrecorded. */
    ecefAt(track, ms) {
      const at = positionAt(track, ms);
      return at
        ? positionToEcef({ lon: at.lon, lat: at.lat, height: at.alt })
        : null;
    },
    /** A sphere around every contact at `ms`, or at its first fix when not recorded then. */
    sphereAt(ms) {
      const points = [];
      for (const track of tracks.values()) {
        const at = positionAt(track, ms) ?? track.points[0];
        if (at) points.push(ecefOf(at));
      }
      return boundingSphere(points);
    },
    dispose() {
      dots.dispose();
      trails.dispose();
    },
  };
}
