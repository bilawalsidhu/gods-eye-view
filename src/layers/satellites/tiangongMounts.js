import { TIANGONG_NORAD } from './policy.js';
import {
  issMountView,
  issMountWorld,
  issNextMountView,
  issPreviousMountView,
} from './issMounts.js';

/**
 * The Cockpit's views from Tiangong, as `issMounts.js` gives the ISS's: a
 * place on the model (`eye`, metres on the model's axes: port, zenith,
 * forward) and where it looks (`forward`, `up`). The model is the layer's
 * own build (`public/models/README.md`): Tianhe along the forward axis with
 * the node at its forward end, Wentian and Mengtian out to either side of
 * the node, a Shenzhou on the forward and nadir ports and a Tianzhou aft.
 * The views are from the modules the catalog lists (CSS (TIANHE), CSS
 * (WENTIAN), CSS (MENGTIAN)) and from the docked vehicle, so each rides an
 * entry of its own; Tiangong needs no cards.
 */

export const TIANGONG_WENTIAN_NORAD = 53239;
export const TIANGONG_MENGTIAN_NORAD = 54216;

const mount = (eye, forward, up) =>
  Object.freeze({
    eye: Object.freeze(eye),
    forward: Object.freeze(forward),
    up: Object.freeze(up),
  });

export const TIANGONG_MOUNTS = Object.freeze({
  /**
   * Tianhe lies along the station's long axis, its wings at the aft end:
   * from the top of the hull just forward of the wing roots, looking ahead
   * along the station to the node and the two labs across it, the Earth
   * below.
   */
  tianhe: mount([0, 3.0, -3], [0, -0.4, 0.92], [0, 1, 0]),
  /**
   * Wentian reaches out from the node on the model's starboard side: from
   * the top of its outer end, looking out past its wings and down, the
   * arrays turning through the view as they follow the Sun.
   */
  wentian: mount([-14, 2.9, 6.4], [-0.8, -0.5, 0.3], [0, 1, 0]),
  /** Mengtian, the same on the port side. */
  mengtian: mount([14, 2.9, 6.4], [0.8, -0.5, 0.3], [0, 1, 0]),
  /**
   * A docked vehicle (a Shenzhou, a Tianzhou): the catalog does not say
   * which port it is on, so it takes the place of the Tianzhou on the aft
   * port: looking out behind the station and down, the Earth falling away.
   */
  docked: mount([2.4, 0.5, -13], [0, -0.5, -0.87], [0, 1, 0]),
});

export const TIANGONG_MOUNT_ORDER = Object.freeze([
  'tianhe',
  'wentian',
  'mengtian',
  'docked',
]);

/**
 * The views on offer, in order, each with the name it is shown under and
 * the catalog entry it rides: the modules whenever the station is drawn
 * (with no entry to ride when the catalog lacks one), the docked vehicle
 * only when there is one.
 * @param {{tianheName?: string|null, wentianName?: string|null,
 *   mengtianName?: string|null, dockedName?: string|null,
 *   tianheNorad?: number|null, wentianNorad?: number|null,
 *   mengtianNorad?: number|null, dockedNorad?: number|null}} [input]
 * @returns {Array<{key: 'tianhe'|'wentian'|'mengtian'|'docked',
 *   label: string, noradId: number|null, card: null}>}
 */
export function tiangongMountViews({
  tianheName,
  wentianName,
  mengtianName,
  dockedName,
  tianheNorad = null,
  wentianNorad = null,
  mengtianNorad = null,
  dockedNorad = null,
} = {}) {
  const labels = {
    tianhe: tiangongMountLabel(tianheName) || 'TIANHE',
    wentian: tiangongMountLabel(wentianName) || 'WENTIAN',
    mengtian: tiangongMountLabel(mengtianName) || 'MENGTIAN',
    docked: tiangongMountLabel(dockedName),
  };
  const entries = {
    tianhe: tianheNorad,
    wentian: wentianNorad,
    mengtian: mengtianNorad,
    docked: dockedNorad,
  };
  return TIANGONG_MOUNT_ORDER.filter((key) => labels[key]).map((key) => ({
    key,
    label: labels[key],
    noradId: Number.isFinite(entries[key]) ? entries[key] : null,
    card: null,
  }));
}

/**
 * A view's name from its entry's catalog name, without the "CSS (…)" the
 * catalog wraps the station's modules in.
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function tiangongMountLabel(name) {
  const text = String(name ?? '').trim();
  const inner = /^CSS\s*\((.+)\)$/i.exec(text);
  return (inner ? inner[1] : text).trim();
}

/**
 * The station model spec's `cockpitMount` for Tiangong: the view asked for
 * (the first when none is, or it is not on offer), in the world.
 * @param {{key: string|null, centre: {x:number,y:number,z:number},
 *   axes: {x:number[], y:number[], z:number[]},
 *   name: (noradId: number|null) => string|null,
 *   entry: (noradId: number|null) => number|null,
 *   dockedVehicle: number|null}} input
 * @returns {object}
 */
export function tiangongCockpitMount({
  key,
  centre,
  axes,
  name,
  entry,
  dockedVehicle,
}) {
  const views = tiangongMountViews({
    tianheName: name(TIANGONG_NORAD),
    wentianName: name(TIANGONG_WENTIAN_NORAD),
    mengtianName: name(TIANGONG_MENGTIAN_NORAD),
    dockedName: name(dockedVehicle),
    tianheNorad: entry(TIANGONG_NORAD),
    wentianNorad: entry(TIANGONG_WENTIAN_NORAD),
    mengtianNorad: entry(TIANGONG_MENGTIAN_NORAD),
    dockedNorad: entry(dockedVehicle),
  });
  const view = issMountView(views, key);
  return {
    ...issMountWorld(TIANGONG_MOUNTS[view.key], centre, axes),
    key: view.key,
    label: view.label,
    noradId: view.noradId,
    card: view.card,
    views,
  };
}

export { issNextMountView as tiangongNextMountView };
export { issPreviousMountView as tiangongPreviousMountView };
