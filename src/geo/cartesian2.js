// Ported from CesiumJS 1.138 (Apache-2.0) — Cartesian2.js
//
// 2D vectors (screen coordinates) as plain-data {x, y} objects.
//
// Geo values are not Object.prototype objects, so src/app/stateChannel.js
// copyState and src/director/documentFields.js jsonTree reject them: copy
// the fields into a literal before putting one into product state or a
// scene document.

// Values are instances of a module-private constructor rather than object
// literals: every `{x, y}` literal in the process shares one V8 hidden
// class, and code elsewhere that builds such literals would make geo's hot
// functions polymorphic. The instances still look like plain data: own
// enumerable fields only, no prototype methods or getters.
function Vector2(x, y) {
  this.x = x;
  this.y = y;
}

/** A vector (Cesium's `new Cartesian2(x, y)`). */
export function create(x, y) {
  return new Vector2(x ?? 0.0, y ?? 0.0);
}

/** Copies a vector; `undefined` when there is none. */
export function clone(cartesian, result) {
  if (cartesian == null) return undefined;
  if (result == null) return create(cartesian.x, cartesian.y);
  result.x = cartesian.x;
  result.y = cartesian.y;
  return result;
}

/** The distance between two points. */
export function distance(left, right) {
  const x = left.x - right.x;
  const y = left.y - right.y;
  return Math.sqrt(x * x + y * y);
}
