// Deterministic TLE catalogs for browser QA; no live feed requests.
import { W1_FROZEN_MS } from './w1Feeds.js';

const checksum = (line) => {
  const body = line.padEnd(68).slice(0, 68);
  let sum = 0;
  for (const c of body) sum += /[0-9]/.test(c) ? Number(c) : c === '-' ? 1 : 0;
  return body + (sum % 10);
};
const tle = (id, name, index, inclination, motion) => {
  const number = String(id).padStart(5, '0');
  const angle = (value) => (value % 360).toFixed(4).padStart(8);
  return [
    name,
    checksum(
      `1 ${number}U 26001A   26289.50000000  .00000000  00000-0  00000-0 0  999`,
    ),
    checksum(
      `2 ${number} ${angle(inclination)} ${angle(index * 137.508)} 0003000 ${angle(0)} ${angle(index * 47.3)} ${motion.toFixed(8).padStart(11)}00001`,
    ),
  ].join('\n');
};
const GROUPS = {
  stations: [25544, 1, 51.64, 15.5, 'ISS (ZARYA)'],
  visual: [30000, 720, 53, 15.2, 'QA VISUAL'],
  'gps-ops': [40000, 32, 55, 2.0056, 'QA GPS'],
  'glo-ops': [41000, 24, 64.8, 2.131, 'QA GLONASS'],
  galileo: [42000, 30, 56, 1.7047, 'QA GALILEO'],
  geo: [45000, 32, 0.1, 1.0027, 'QA GEO'],
  starlink: [50000, 6000, 53, 15.2, 'QA STARLINK'],
  resource: [60000, 12, 98.2, 14.6, 'QA RESOURCE'],
  weather: [61000, 8, 98.7, 14.1, 'QA WEATHER'],
  planet: [62000, 24, 97.5, 15.1, 'QA PLANET'],
  sar: [63000, 6, 97.9, 15.0, 'QA SAR'],
  science: [64000, 6, 28.5, 15.1, 'QA SCIENCE'],
};
export const SATELLITE_FIXTURE_EPOCH = W1_FROZEN_MS;
export function satelliteFixture(group) {
  const spec = GROUPS[group];
  if (!spec) throw new TypeError('Unknown fixture group');
  const [first, count, inclination, motion, prefix] = spec;
  return (
    Array.from({ length: count }, (_, i) =>
      tle(
        first + i,
        count === 1 ? prefix : `${prefix} ${i + 1}`,
        i,
        inclination,
        motion,
      ),
    ).join('\n') + '\n'
  );
}
