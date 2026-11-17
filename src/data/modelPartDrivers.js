/**
 * @module modelPartDrivers
 * @description What the live layers ask of a fleet model's moving parts
 * (`ModelItem.parts`), from a vehicle's own record: each a pure function of
 * the model's part table and what the record says, so the same record poses
 * the same parts at any time. A model without a part table gets none, and a
 * renderer that does not pose parts draws the model whole, at rest.
 *
 * Which parts each rule drives is read from the table by kind and name:
 *
 * - **Aircraft and helicopters** ({@link aircraftPartState}). Spin parts
 *   named `fan…`, `prop…` and `rotor…` turn while the aircraft is airborne,
 *   or on the ground moving faster than {@link MOVING_MPS}. Hinge parts named
 *   `gear…` are down on the ground; in the air they come down between
 *   {@link GEAR_APPROACH_M} metres above the ground when descending faster
 *   than {@link DESCENDING_MPS} (an approach), and otherwise are down below
 *   {@link GEAR_TAKEOFF_M}`[0]` and up above `[1]` (after take-off), in
 *   between in proportion. Without a height above the ground (no ground
 *   height known under it), the gear is down while it descends faster than
 *   {@link DESCENDING_MPS} slower than {@link APPROACH_MPS} below
 *   {@link APPROACH_CEILING_M} (an approach: the highest runways are about
 *   4,400 m up), and up otherwise. Their doors (`door…`) open over the first
 *   quarter of the gear's travel and stay open while it is out; flaps
 *   (`flap…`) follow the gear in the air and are up on the ground.
 * - **Vessels** ({@link vesselPartState}): spin parts named `radar…` sweep
 *   while the vessel is under way, faster than {@link UNDER_WAY_MPS}.
 * - **Road and rail vehicles** ({@link groundVehiclePartState}): spin parts
 *   named `axle…` roll with the vehicle's speed (their pivot's height is the
 *   wheel's radius), and slide parts named `doors…` are open while the
 *   vehicle is stopped at a stop.
 *
 * Fractions and speeds are rounded ({@link DEPLOY_STEP}, {@link SPEED_STEP_MPS})
 * so a record that barely changes asks for the same state.
 */

/** Ground speed (m/s) above which a grounded aircraft's engines turn. */
export const MOVING_MPS = 1;
/** Vertical rate (m/s, negative down) below which an aircraft is descending. */
export const DESCENDING_MPS = -1;
/** Heights above the ground (m) over which the gear comes down on approach: up at the first, down at the second. */
export const GEAR_APPROACH_M = Object.freeze([750, 600]);
/** Heights above the ground (m) over which the gear goes up otherwise: down at the first, up at the second. */
export const GEAR_TAKEOFF_M = Object.freeze([100, 300]);
/** Ground speed (m/s) under which a descending aircraft is on approach, where no ground height is known (about 165 kt). */
export const APPROACH_MPS = 85;
/** Altitude (m) under which a descending aircraft may be on approach, where no ground height is known. */
export const APPROACH_CEILING_M = 5000;
/** Speed (m/s) above which a vessel is under way. */
export const UNDER_WAY_MPS = 0.5;
/** Speed (m/s) under which a vehicle at a stop is stopped there. */
export const STOPPED_MPS = 0.5;
/** Deploy fractions are rounded to this step. */
export const DEPLOY_STEP = 1 / 32;
/** Speeds are rounded to this step (m/s) before they turn wheels. */
export const SPEED_STEP_MPS = 0.5;

/** Degrees a second each spinning part turns at, by name. */
export const SPIN_RATES_DPS = Object.freeze({
  rotor_tail: 3000,
  rotor: 1080,
  prop: 1500,
  fan: 900,
  radar: 144,
});

/** A wheel's radius (m) where its axle's pivot does not say. */
const DEFAULT_WHEEL_RADIUS_M = 0.4;

const RADIANS_TO_DEGREES = 180 / Math.PI;

/** `value` rounded to `step`. */
const rounded = (value, step) => Math.round(value / step) * step;

/** 0..1 between `from` (0) and `to` (1), linear, clamped. */
function ramp(value, from, to) {
  const t = (value - from) / (to - from);
  return Math.min(1, Math.max(0, t));
}

/**
 * Whether an aircraft's engines and rotors turn: airborne, or on the ground
 * moving faster than {@link MOVING_MPS}. The rotor sprite (`rotorFrames.js`)
 * follows the same rule as the model's spinning parts.
 * @param {{onGround?: boolean, speedMps?: number|null}} aircraft
 * @returns {boolean}
 */
export function enginesTurn({ onGround, speedMps }) {
  return (
    !onGround ||
    (typeof speedMps === 'number' &&
      Number.isFinite(speedMps) &&
      speedMps > MOVING_MPS)
  );
}

/** A spin part's rate by its name, or 0 for a name not listed. */
function spinRate(name) {
  if (name === 'rotor_tail') return SPIN_RATES_DPS.rotor_tail;
  for (const prefix of ['rotor', 'prop', 'fan', 'radar'])
    if (name.startsWith(prefix)) return SPIN_RATES_DPS[prefix];
  return 0;
}

/** Each part of `kind` whose name starts with one of `prefixes`. */
function* partsOf(table, kind, prefixes) {
  for (const part of table?.parts ?? [])
    if (part.kind === kind && prefixes.some((p) => part.name.startsWith(p)))
      yield part;
}

/** A state with only the members that name a part; undefined for none. */
function stateOf(spin, deploy) {
  const out = {};
  if (Object.keys(spin).length) out.spin = spin;
  if (Object.keys(deploy).length) out.deploy = deploy;
  return out.spin || out.deploy ? out : undefined;
}

/**
 * How far an aircraft's gear is down, 0 (up) to 1 (down), by the rule in the
 * module comment.
 * @param {{onGround?: boolean, heightAboveGroundM?: number|null,
 *   altitudeM?: number|null, verticalRateMps?: number|null,
 *   speedMps?: number|null}} aircraft
 * @returns {number}
 */
export function gearDown({
  onGround,
  heightAboveGroundM,
  altitudeM,
  verticalRateMps,
  speedMps,
}) {
  if (onGround) return 1;
  const known = (v) => typeof v === 'number' && Number.isFinite(v);
  const descending = known(verticalRateMps) && verticalRateMps < DESCENDING_MPS;
  const h = heightAboveGroundM;
  if (!known(h))
    return descending &&
      known(speedMps) &&
      speedMps < APPROACH_MPS &&
      (!known(altitudeM) || altitudeM < APPROACH_CEILING_M)
      ? 1
      : 0;
  const down = descending
    ? Math.max(
        ramp(h, GEAR_APPROACH_M[0], GEAR_APPROACH_M[1]),
        ramp(h, GEAR_TAKEOFF_M[1], GEAR_TAKEOFF_M[0]),
      )
    : ramp(h, GEAR_TAKEOFF_M[1], GEAR_TAKEOFF_M[0]);
  return rounded(down, DEPLOY_STEP);
}

/**
 * An aircraft's or helicopter's part state, by the rule in the module
 * comment; undefined when its model has no part the rule drives.
 * @param {import('../render/modelParts').PartTable|null|undefined} table
 * @param {{onGround?: boolean, heightAboveGroundM?: number|null,
 *   altitudeM?: number|null, verticalRateMps?: number|null,
 *   speedMps?: number|null}} aircraft
 * @returns {import('../render/contract/draw').ModelPartState|undefined}
 */
export function aircraftPartState(table, aircraft) {
  if (!table) return undefined;
  const spin = {};
  const deploy = {};
  if (enginesTurn(aircraft))
    for (const part of partsOf(table, 'spin', ['fan', 'prop', 'rotor']))
      spin[part.name] = spinRate(part.name);
  const gear = gearDown(aircraft);
  const doors = Math.min(1, rounded(gear * 4, DEPLOY_STEP));
  for (const part of partsOf(table, 'hinge', ['gear']))
    deploy[part.name] = gear;
  for (const part of partsOf(table, 'hinge', ['door']))
    deploy[part.name] = doors;
  for (const part of partsOf(table, 'hinge', ['flap']))
    deploy[part.name] = aircraft.onGround ? 0 : gear;
  return stateOf(spin, deploy);
}

/**
 * The part state of a contact in an aircraft layer: an airport vehicle
 * (class `vehicle`) is a road vehicle ({@link groundVehiclePartState}, its
 * wheels rolling with its speed, never at a stop), every other contact an
 * aircraft ({@link aircraftPartState}).
 * @param {import('../render/modelParts').PartTable|null|undefined} table
 * @param {{klass?: string|null, onGround?: boolean,
 *   heightAboveGroundM?: number|null, altitudeM?: number|null,
 *   verticalRateMps?: number|null, speedMps?: number|null}} contact
 * @returns {import('../render/contract/draw').ModelPartState|undefined}
 */
export function aircraftLayerPartState(table, contact) {
  return contact.klass === 'vehicle'
    ? groundVehiclePartState(table, { speedMps: contact.speedMps })
    : aircraftPartState(table, contact);
}

/**
 * A vessel's part state, by the rule in the module comment; undefined when
 * it is not under way or its model has no radar.
 * @param {import('../render/modelParts').PartTable|null|undefined} table
 * @param {{speedMps?: number|null}} vessel
 * @returns {import('../render/contract/draw').ModelPartState|undefined}
 */
export function vesselPartState(table, { speedMps }) {
  if (!table || !(typeof speedMps === 'number' && speedMps > UNDER_WAY_MPS))
    return undefined;
  const spin = {};
  for (const part of partsOf(table, 'spin', ['radar']))
    spin[part.name] = SPIN_RATES_DPS.radar;
  return stateOf(spin, {});
}

/**
 * A road or rail vehicle's part state, by the rule in the module comment;
 * undefined when it neither moves nor stands at a stop, or its model has no
 * part the rule drives.
 * @param {import('../render/modelParts').PartTable|null|undefined} table
 * @param {{speedMps?: number|null, atStop?: boolean}} vehicle
 * @returns {import('../render/contract/draw').ModelPartState|undefined}
 */
export function groundVehiclePartState(table, { speedMps, atStop }) {
  if (!table) return undefined;
  const speed =
    typeof speedMps === 'number' && Number.isFinite(speedMps)
      ? rounded(Math.max(0, speedMps), SPEED_STEP_MPS)
      : 0;
  const spin = {};
  const deploy = {};
  if (speed > 0)
    for (const part of partsOf(table, 'spin', ['axle'])) {
      const radius =
        part.pivot[1] > 0.05 ? part.pivot[1] : DEFAULT_WHEEL_RADIUS_M;
      // Rolling forward (−X) on the ground turns a wheel about +Z (its left).
      const sign = Math.sign(part.axis?.[2] ?? 0);
      if (sign !== 0)
        spin[part.name] = (sign * speed * RADIANS_TO_DEGREES) / radius;
    }
  if (atStop && speed < STOPPED_MPS)
    for (const part of partsOf(table, 'slide', ['doors']))
      deploy[part.name] = 1;
  return stateOf(spin, deploy);
}
