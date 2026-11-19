/**
 * Where each recorded layer's positions come from, stored with every point so a
 * history can say which feed a row came from (and so a feed that restricts
 * storing its data can be found and purged). Names are short and stable.
 */
export const SOURCE_BY_LAYER = {
  air: 'opensky',
  mil: 'adsb.lol',
  vessel: 'aisstream',
  local: 'local-receiver',
  sat: 'celestrak',
};

/** The point with `source` filled in from its layer, unless it already has one. */
export function withSource(point) {
  if (point.source) return point;
  const source = SOURCE_BY_LAYER[point.layer];
  return source ? { ...point, source } : point;
}
