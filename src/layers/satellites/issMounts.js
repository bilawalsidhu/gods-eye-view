import { msg } from '../../i18n/index.js';

/**
 * Where the Cockpit camera sits when it rides the station. The ISS has
 * several catalog entries that are one body (the ISS itself, listed under
 * Zarya, its first module; Nauka; whatever vehicle is docked). Riding any of
 * them looks out from a point on its 3D model, away from the station, in
 * place of the straight-down picture every other satellite has, and the
 * Cockpit steps between the views: from Nauka, from Zarya, from Poisk, from
 * the Cupola, from Kibo, from a docked vehicle. Each looks outward, in a direction of its own, and the
 * arrows turn the view from there. From this height the Earth's limb is 20°
 * below level: a view 30° down has it across its upper part.
 *
 * The points were chosen by casting rays across the view against the model
 * at rest: each is over a meter clear of every surface, and at most a tenth
 * of its frame meets the station, none of it nearer than 12 m.
 *
 * Points and directions are on the model's axes in meters (X port, Y zenith,
 * Z forward), from the model's origin: the frame the file's nodes sit in.
 */

/**
 * The station's modules that have catalog entries of their own, beside the
 * ISS's (ISS_NORAD in policy.js, listed as "ISS (ZARYA)"): Nauka and Poisk.
 */
export const ISS_NAUKA_NORAD = 49044;
export const ISS_POISK_NORAD = 36086;

const mount = (eye, forward, up) =>
  Object.freeze({
    eye: Object.freeze(eye),
    forward: Object.freeze(forward),
    up: Object.freeze(up),
  });

export const ISS_MOUNTS = Object.freeze({
  /**
   * Nauka hangs below Zvezda, pointing at the Earth: from the port side of
   * its lower end, looking out ahead of the station to port and down.
   */
  nauka: mount([3.03, -12, -24.25], [0.75, -0.5, 0.43], [0, 1, 0]),
  /**
   * Zarya lies along the station's long axis, docked at both ends, so it
   * looks out sideways: from its port side, out across the track and down.
   */
  zarya: mount([3.38, 2.96, -22], [0.87, -0.5, 0], [0, 1, 0]),
  /**
   * Poisk stands on top of Zvezda, pointing away from the Earth: from the
   * top of it, looking out behind the station to starboard, the limb across
   * the middle of the frame.
   */
  poisk: mount([-1.27, 12, -27.27], [-0.66, -0.34, -0.66], [0, 1, 0]),
  /**
   * A docked vehicle (a Progress, a Soyuz, a Dragon): the catalog does not
   * say which port it is on, so it takes the place of one on Zvezda's aft
   * port, the most used: looking out behind the station and down, the Earth
   * falling away.
   */
  docked: mount([0, 2.05, -41.5], [0, -0.5, -0.87], [0, 1, 0]),
  /**
   * The Cupola, on Tranquility's Earth-facing port: from just below it,
   * looking aft along the station and down, the Russian segment (Zvezda,
   * Nauka, the docked vehicles) in the corner and the Earth beyond.
   */
  cupola: mount([8.3, -3.2, -4.9], [0, -0.5, -0.87], [0, 1, 0]),
  /**
   * Kibo, on Harmony's port side: its two windows are on its port end, above
   * the airlock. From just outside them, looking out to port and down over
   * the Exposed Facility, the Earth beyond it. The port solar arrays turn
   * through this view as they follow the Sun, as they do past the windows.
   */
  kibo: mount([15.4, 4.2, 11], [0.81, -0.5, -0.3], [0, 1, 0]),
});

/**
 * The card a view shows in place of its catalog entry's, for a module the
 * catalog has no entry for. Its texts are marked for translation; the name
 * is the module's, as catalog names are.
 */
export const ISS_MOUNT_CARDS = Object.freeze({
  cupola: Object.freeze({
    name: 'CUPOLA',
    classLabel: msg('OBSERVATION MODULE · ISS'),
    operator: msg('European Space Agency (ESA)'),
    facts: Object.freeze([
      msg('7 WINDOWS'),
      msg('LAUNCHED 8 FEB 2010 · STS-130'),
      msg('TRANQUILITY · EARTH-FACING PORT'),
    ]),
  }),
  kibo: Object.freeze({
    name: 'KIBO',
    classLabel: msg('LABORATORY MODULE · ISS'),
    operator: msg('Japan Aerospace Exploration Agency (JAXA)'),
    facts: Object.freeze([
      msg('2 WINDOWS'),
      msg('LAUNCHED 31 MAY 2008 · STS-124'),
      msg('HARMONY · PORT SIDE'),
    ]),
  }),
});

/**
 * The views in the order the Cockpit steps through them. The first is the
 * one it opens on, whichever of the station's entries was selected.
 */
export const ISS_MOUNT_ORDER = Object.freeze([
  'nauka',
  'zarya',
  'poisk',
  'cupola',
  'kibo',
  'docked',
]);

/**
 * The views the station offers now, in ISS_MOUNT_ORDER. Nauka, Zarya and
 * Poisk are part of the model, so they are always there; the docked-vehicle
 * view is offered only while a vehicle is docked, under that vehicle's name.
 * Each view names the catalog entry it belongs to (the ISS itself for
 * Zarya), so the Cockpit can ride that entry and its card describe it; null
 * when the catalog has no entry for it. The Cupola and Kibo have none: they
 * ride the ISS's and carry cards of their own (ISS_MOUNT_CARDS).
 * @param {{naukaName?: string|null, zaryaName?: string|null,
 *   poiskName?: string|null, dockedName?: string|null,
 *   naukaNorad?: number|null, zaryaNorad?: number|null,
 *   poiskNorad?: number|null, dockedNorad?: number|null}} [entries]
 *   Catalog names (e.g. "ISS (NAUKA)") and numbers.
 * @returns {Array<{key: 'nauka'|'zarya'|'poisk'|'cupola'|'kibo'|'docked',
 *   label: string, noradId: number|null, card: object|null}>}
 */
export function issMountViews({
  naukaName,
  zaryaName,
  poiskName,
  dockedName,
  naukaNorad = null,
  zaryaNorad = null,
  poiskNorad = null,
  dockedNorad = null,
} = {}) {
  const labels = {
    nauka: issMountLabel(naukaName) || 'NAUKA',
    zarya: issMountLabel(zaryaName) || 'ZARYA',
    poisk: issMountLabel(poiskName) || 'POISK',
    cupola: ISS_MOUNT_CARDS.cupola.name,
    kibo: ISS_MOUNT_CARDS.kibo.name,
    docked: issMountLabel(dockedName),
  };
  const entries = {
    nauka: naukaNorad,
    zarya: zaryaNorad,
    poisk: poiskNorad,
    cupola: zaryaNorad,
    kibo: zaryaNorad,
    docked: dockedNorad,
  };
  return ISS_MOUNT_ORDER.filter((key) => labels[key]).map((key) => ({
    key,
    label: labels[key],
    noradId: Number.isFinite(entries[key]) ? entries[key] : null,
    card: ISS_MOUNT_CARDS[key] ?? null,
  }));
}

/**
 * The view to show: the one asked for while it is on offer, else the first.
 * @param {Array<{key: string, label: string}>} views From issMountViews.
 * @param {string|null|undefined} key
 * @returns {{key: string, label: string}}
 */
export function issMountView(views, key) {
  return views.find((view) => view.key === key) ?? views[0];
}

/**
 * The view after the current one, wrapping round; null with fewer than two.
 * @param {Array<{key: string, label: string}>} views
 * @param {string|null|undefined} key The current view.
 * @returns {{key: string, label: string}|null}
 */
export function issNextMountView(views, key) {
  if (!Array.isArray(views) || views.length < 2) return null;
  const index = views.findIndex((view) => view.key === key);
  return views[(index + 1) % views.length];
}

/**
 * The view before the current one, wrapping round; null with fewer than two.
 * An unknown current view steps back to the last.
 * @param {Array<{key: string, label: string}>} views
 * @param {string|null|undefined} key The current view.
 * @returns {{key: string, label: string}|null}
 */
export function issPreviousMountView(views, key) {
  if (!Array.isArray(views) || views.length < 2) return null;
  const index = views.findIndex((view) => view.key === key);
  return views[(Math.max(index, 0) - 1 + views.length) % views.length];
}

/**
 * The name the Cockpit shows for the view: the entry's own, without the
 * "ISS (…)" the catalog wraps the station's modules in.
 * @param {string|null|undefined} name Catalog name, e.g. "ISS (ZARYA)".
 * @returns {string}
 */
export function issMountLabel(name) {
  const text = String(name ?? '').trim();
  const inner = /^ISS\s*\((.+)\)$/i.exec(text);
  return (inner ? inner[1] : text).trim();
}

const add = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const point = (v) => ({ x: v[0], y: v[1], z: v[2] });

/**
 * A mount in the world: the eye point and the view's frame, Earth-fixed.
 * The model is placed with its forward axis along the flight direction, its
 * port axis along the orbit normal and its zenith axis away from the Earth
 * (issFlightAxes), so a model vector [port, zenith, forward] is
 * port × axes.y + zenith × axes.z + forward × axes.x.
 * @param {{eye: number[], forward: number[], up: number[]}} mount
 * @param {{x: number, y: number, z: number}} centre The model's origin.
 * @param {{x: number[], y: number[], z: number[]}} axes Flight axes.
 * @returns {{position: object, direction: object, up: object, right: object}}
 *   `{x, y, z}` vectors; direction, up and right are unit and perpendicular,
 *   right = direction × up.
 */
export function issMountWorld(mount, centre, axes) {
  const toWorld = ([port, zenith, forward]) =>
    add(add(add([0, 0, 0], axes.y, port), axes.z, zenith), axes.x, forward);
  const direction = unit(toWorld(mount.forward));
  // Up, squared to the direction: the mount's own need not be exact.
  const rough = toWorld(mount.up);
  const up = unit(add(rough, direction, -dot(rough, direction)));
  const offset = toWorld(mount.eye);
  return {
    position: {
      x: centre.x + offset[0],
      y: centre.y + offset[1],
      z: centre.z + offset[2],
    },
    direction: point(direction),
    up: point(up),
    right: point(cross(direction, up)),
  };
}
