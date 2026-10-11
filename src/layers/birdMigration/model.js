/**
 * Bird migration domain. A frame is a composite scan time plus a motion union;
 * only `reduced` motion holds stations, and only a `tracked` station holds a
 * direction, always beside the VAD fit that produced it.
 *
 * @typedef {{ lat: number, lon: number, elevM: number }} StationPosition
 * @typedef {{
 *   velocityProduct: 'N0U', maskProduct: 'N0C', gateCount: number,
 *   azimuthCoverageDeg: number, residualMs: number,
 *   annulusKm: readonly [number, number], beamHeightM: readonly [number, number],
 * }} VadFit
 * @typedef {{ towardDeg: number, speedMs: number }} Track  towardDeg: clockwise from north, where the scatter is going
 * @typedef {(
 *   | { kind: 'tracked', site: string, position: StationPosition, scanTime: string, track: Track, fit: VadFit }
 *   | { kind: 'precipitation', site: string, position: StationPosition, scanTime: string, rainFraction: number }
 *   | { kind: 'quiet', site: string, position: StationPosition, scanTime: string }
 *   | { kind: 'unfit', site: string, position: StationPosition, scanTime: string, reason: 'azimuth-gap' | 'residual' | 'implausible-speed' }
 *   | { kind: 'no-scan', site: string, position: StationPosition }
 * )} StationOutcome
 * @typedef {(
 *   | { kind: 'pending' }
 *   | { kind: 'unavailable', reason: string }
 *   | { kind: 'reduced', reducedAt: string, final: boolean, sampleRadiusKm: number, stations: readonly StationOutcome[] }
 * )} Motion
 * @typedef {{ time: string, motion: Motion }} MigrationFrame
 */

export const BIRD_MIGRATION_ID = 'bird-migration';
export const STATION_KINDS = Object.freeze([
  'tracked',
  'precipitation',
  'quiet',
  'unfit',
  'no-scan',
]);
export const UNFIT_REASONS = Object.freeze([
  'azimuth-gap',
  'residual',
  'implausible-speed',
]);
/** Reflectivity kept on the wash; quoted by the card. */
export const PATTERN_DBZ = Object.freeze({ min: 5, max: 35 });
/** A streak is the ground covered in this many seconds. */
export const TRAVEL_SCALE_S = 3600;
export const ATTRIBUTION =
  'NWS radar · reflectivity tiles via Iowa State IEM · not endorsed by NOAA';

/** A reduced result replaces anything; nothing replaces a reduced result except another. */
export function mergeMotion(previous, next) {
  if (next.kind === 'reduced' || previous?.kind !== 'reduced') return next;
  return previous;
}

const utc = (time) => `${time.slice(5, 16).replace('T', ' ')} UTC`;

/**
 * Card model for one frame. Every claim is derived from the frame's motion
 * variant, so the text cannot state a direction the data does not hold.
 * @param {MigrationFrame | null} frame
 */
export function describeFrame(frame) {
  const lines = [
    {
      id: 'pattern',
      text: `Pattern: all low-altitude echo, ${PATTERN_DBZ.min}–${PATTERN_DBZ.max} dBZ. Light rain is not removed from the wash.`,
    },
  ];
  let counts = null;
  let status = null;
  const motion = frame?.motion;
  if (!frame) status = 'Waiting for radar scans';
  else if (motion.kind === 'pending')
    lines.unshift({
      id: 'direction',
      text: 'Direction for this time: reducing radar velocity…',
    });
  else if (motion.kind === 'unavailable')
    lines.unshift({
      id: 'direction',
      text: `Direction unavailable: ${motion.reason}`,
    });
  else {
    counts = Object.fromEntries(STATION_KINDS.map((kind) => [kind, 0]));
    for (const station of motion.stations) counts[station.kind]++;
    const fits = motion.stations.filter(({ kind }) => kind === 'tracked');
    const low = Math.min(...fits.map(({ fit }) => fit.beamHeightM[0]));
    const high = Math.max(...fits.map(({ fit }) => fit.beamHeightM[1]));
    lines.unshift(
      {
        id: 'direction',
        text: `Radars: ${counts.tracked} tracked · ${counts.precipitation} rain · ${counts.quiet} quiet · ${counts.unfit} unresolved · ${counts['no-scan']} no scan`,
      },
      {
        id: 'arrows',
        text: `Arrows: ground track of dual-pol-filtered biological echo${fits.length ? ` ${Math.round(low)}–${Math.round(high)} m up` : ''}, one hour of travel. Not bird heading. Birds and insects are not separated.`,
      },
    );
    if (counts.precipitation)
      lines.push({
        id: 'rain',
        text: 'Grey disc: that radar mostly sees rain; no direction is drawn.',
        muted: true,
      });
    if (!motion.final)
      lines.push({
        id: 'partial',
        text: 'Partial: newer scans still arriving',
        muted: true,
      });
  }
  return {
    label: 'Bird migration · US',
    coverage: 'CONUS radars',
    detail: frame ? utc(frame.time) : 'Waiting for radar scans',
    status,
    lines,
    counts,
    attribution: ATTRIBUTION,
  };
}
