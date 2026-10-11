/**
 * The weather rail's members in card order. Observed members share the
 * history timeline. PANEL_GROUPS keeps its own authored row order; a test pins
 * its Weather ids to this list.
 * @type {readonly { id: string, history: 'none' | 'forecast' | 'observed', name?: string }[]}
 */
export const WEATHER_FAMILY = Object.freeze([
  Object.freeze({ id: 'weather-cyclones', history: 'none' }),
  Object.freeze({ id: 'wind', history: 'forecast' }),
  Object.freeze({
    id: 'bird-migration',
    history: 'observed',
    name: 'Bird migration',
  }),
  Object.freeze({
    id: 'weather-radar',
    history: 'observed',
    name: 'Rain radar',
  }),
  Object.freeze({
    id: 'weather-satellite',
    history: 'observed',
    name: 'Satellite clouds',
  }),
  Object.freeze({
    id: 'weather-lightning',
    history: 'observed',
    name: 'Lightning density',
  }),
]);

export const WEATHER_FAMILY_IDS = Object.freeze(
  WEATHER_FAMILY.map(({ id }) => id),
);
