/**
 * The sky the user chooses in the Display panel's Sky group: the
 * atmosphere, sun lighting (day and night by scene time), the sun and moon,
 * the stars and the Milky Way's brightness, through the renderer's
 * `globe.sky`. The choice is kept across visits; what the user has not set
 * stays as the renderer draws it. Distance fog is left to the styles that
 * switch it (infrared).
 */
import { findGlobe } from './render/rendererOf.js';

const STORAGE_KEY = 'godsEyeView.viewSky';
/** The switches the panel lists, in its order. */
export const SKY_SWITCHES = Object.freeze([
  'atmosphere',
  'lighting',
  'sun',
  'moon',
  'stars',
]);

/** The saved choice: only the settings the user set, each checked. */
function readSaved(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return {};
    const choice = {};
    for (const key of SKY_SWITCHES)
      if (typeof saved[key] === 'boolean') choice[key] = saved[key];
    const milkyWay = Number(saved.milkyWay);
    if (Number.isFinite(milkyWay))
      choice.milkyWay = Math.min(1, Math.max(0, milkyWay));
    return choice;
  } catch {
    return {};
  }
}

/**
 * @param {object} viewer The scene host a renderer is bound to.
 * @param {object} options
 * @param {{publishSky: Function, connect: Function, detach: Function}} options.store
 *   The Display store: the panel's Sky group and its controls.
 * @param {Storage} [options.storage]
 * @returns {{destroy: () => void}}
 */
export function createViewSky(
  viewer,
  { store, storage = globalThis.localStorage },
) {
  const sky = findGlobe(viewer)?.sky ?? null;
  if (!sky) {
    store?.publishSky?.(null);
    return { destroy() {} };
  }
  const choice = readSaved(storage);
  if (Object.keys(choice).length) sky.set(choice);

  function publish() {
    const shown = sky.get();
    store?.publishSky?.({
      switches: Object.fromEntries(
        SKY_SWITCHES.map((key) => [key, Boolean(shown[key])]),
      ),
      milkyWay: Math.round((shown.milkyWay ?? 0) * 100),
    });
  }

  function save() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(choice));
    } catch {
      // Private mode: the choice lasts the visit.
    }
  }

  function apply(change) {
    Object.assign(choice, change);
    sky.set(change);
    save();
    publish();
  }

  const token = store?.connect?.({
    setSkySwitch(key, on) {
      if (!SKY_SWITCHES.includes(key)) return;
      apply({ [key]: Boolean(on) });
    },
    setSkyMilkyWay(pct) {
      const value = Number(pct) / 100;
      if (!Number.isFinite(value)) return;
      apply({ milkyWay: Math.min(1, Math.max(0, value)) });
    },
  });

  publish();

  return {
    destroy() {
      if (token) store?.detach?.(token);
      store?.publishSky?.(null);
    },
  };
}
