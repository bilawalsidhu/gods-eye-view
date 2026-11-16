import { loadBundledJson } from '../../data/bundledJson.js';
import { createEclipse } from './besselian.js';
import { createLunarEclipse } from './lunar.js';

export const ECLIPSE_ELEMENTS_URL = () =>
  new URL('./elements.json', import.meta.url);
export const LUNAR_ECLIPSES_URL = () =>
  new URL('./lunar.json', import.meta.url);

/**
 * The bundled catalogues of solar eclipses, with their Besselian elements,
 * and of lunar eclipses (Espenak and Meeus, NASA's GSFC). An eclipse never
 * changes, so the files ship with the app and each is read once.
 */
export function createEclipseElementsSource({
  load = (options) => loadBundledJson(ECLIPSE_ELEMENTS_URL(), options),
  loadLunar = (options) => loadBundledJson(LUNAR_ECLIPSES_URL(), options),
} = {}) {
  // One read each, tried again after a failure.
  const once = (read, build) => {
    let result = null;
    return ({ signal } = {}) => {
      result ??= read({ signal }).then(
        (file) => Object.freeze(file.rows.map(build)),
        (error) => {
          result = null;
          throw error;
        },
      );
      return result;
    };
  };
  return Object.freeze({
    id: 'eclipse-paths',
    /** Every bundled solar eclipse, in time order. */
    getCatalog: once(load, createEclipse),
    /** Every bundled lunar eclipse, in time order. */
    getLunarCatalog: once(loadLunar, createLunarEclipse),
  });
}
