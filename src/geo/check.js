// Ported from CesiumJS 1.138 (Apache-2.0) — Check.js
//
// Cesium's argument checks with the same conditions and message text. Only the
// checks src/geo needs are ported. Callers run them inside `if (DEBUG)` blocks
// (see debug.js), as Cesium runs them inside its debug pragmas, so production
// builds drop the calls and this module with them.

import { DeveloperError } from './developerError.js';

const undefinedMessage = (name) =>
  `${name} is required, actual value was undefined`;
const typeMessage = (actual, expected, name) =>
  `Expected ${name} to be typeof ${expected}, actual typeof was ${actual}`;

/** Throws unless `test` is neither undefined nor null. */
function defined(name, test) {
  if (test === undefined || test === null) {
    throw new DeveloperError(undefinedMessage(name));
  }
}

/** Throws unless `typeof test` is 'number' (NaN passes, as in Cesium). */
function number(name, test) {
  if (typeof test !== 'number') {
    throw new DeveloperError(typeMessage(typeof test, 'number', name));
  }
}

// Attached in a function marked pure, not by top-level assignments, so that a
// production build, where no caller runs a check, drops this module entirely.
function withBounds(check) {
  check.lessThanOrEquals = function (name, test, limit) {
    check(name, test);
    if (test > limit) {
      throw new DeveloperError(
        `Expected ${name} to be less than or equal to ${limit}, actual value was ${test}`,
      );
    }
  };
  check.greaterThanOrEquals = function (name, test, limit) {
    check(name, test);
    if (test < limit) {
      throw new DeveloperError(
        `Expected ${name} to be greater than or equal to ${limit}, actual value was ${test}`,
      );
    }
  };
  return check;
}

/** Throws unless `typeof test` is 'object' (null passes, as in Cesium). */
function object(name, test) {
  if (typeof test !== 'object') {
    throw new DeveloperError(typeMessage(typeof test, 'object', name));
  }
}

export const Check = /* @__PURE__ */ Object.freeze({
  defined,
  typeOf: Object.freeze({ number: /* @__PURE__ */ withBounds(number), object }),
});
