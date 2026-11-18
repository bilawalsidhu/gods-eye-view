/**
 * The Cockpit odometer readouts (ground speed, altitude, heading): which
 * glyphs a reading shows and which of them roll. It has no imports, so the
 * view that renders the glyphs can read it.
 */

/** The shortest gap between two rolls, in ms. */
const ROLL_THROTTLE_MS = 220;

// Digit grouping and decimal marks (`26,175`, `26 175`, `26.175`) take a
// narrow cell; a full digit cell would open a gap in the middle of a number.
const ROLL_SEPARATOR = /^[,.\u00a0\u202f]$/;

function rollTokenClass(character) {
  return ROLL_SEPARATOR.test(character)
    ? 'cockpit-roll-token is-separator'
    : 'cockpit-roll-token';
}

/**
 * A readout before its first reading: no glyphs, so the view shows its
 * placeholder.
 * @returns {object}
 */
export function createRollingState() {
  return {
    text: undefined,
    value: NaN,
    at: NaN,
    tokens: null,
    generation: 0,
  };
}

/**
 * Take a reading. A changed reading inside the throttle is dropped; any
 * other reading restamps the readout. A changed reading rolls each digit
 * that differs, unless it is the first or `immediate`, which draw it flat.
 *
 * @param {object} state From createRollingState or an earlier call.
 * @param {string} text The reading as shown.
 * @param {?number} numericValue Its value, for the roll direction.
 * @param {{circularRange?: ?number, immediate?: boolean, nowMs?: number}} [options]
 * @returns {object} `state` itself when its glyphs stay, else a new state
 *   with a new `generation`, so every glyph is drawn afresh and its roll
 *   animation restarts.
 */
export function advanceRollingValue(
  state,
  text,
  numericValue,
  { circularRange = null, immediate = false, nowMs = performance.now() } = {},
) {
  const nextText = String(text);
  const previousText = state.text;
  const previousValue = state.value;
  if (
    !immediate &&
    previousText !== undefined &&
    previousText !== nextText &&
    Number.isFinite(state.at) &&
    nowMs - state.at < ROLL_THROTTLE_MS
  ) {
    return state;
  }
  state.at = nowMs;
  state.value = Number.isFinite(numericValue) ? numericValue : NaN;
  if (previousText === nextText && state.tokens) return state;

  const next = { ...state, text: nextText, generation: state.generation + 1 };
  if (immediate || previousText === undefined || previousText === nextText) {
    next.tokens = Array.from(nextText, (character) => ({
      className: rollTokenClass(character),
      text: character,
      track: null,
    }));
    return next;
  }

  let delta =
    Number.isFinite(numericValue) && Number.isFinite(previousValue)
      ? numericValue - previousValue
      : 0;
  if (Number.isFinite(circularRange) && circularRange > 0) {
    const halfRange = circularRange / 2;
    if (delta > halfRange) delta -= circularRange;
    else if (delta < -halfRange) delta += circularRange;
  }
  const direction = delta < 0 ? 'down' : 'up';
  const width = Math.max(previousText.length, nextText.length);
  const from = previousText.padStart(width, ' ');
  const to = nextText.padStart(width, ' ');
  next.tokens = Array.from(to, (nextCharacter, index) => {
    const previousCharacter = from[index];
    if (
      previousCharacter === nextCharacter ||
      !/\d/.test(previousCharacter) ||
      !/\d/.test(nextCharacter)
    ) {
      return {
        className: rollTokenClass(nextCharacter),
        text: nextCharacter === ' ' ? '\u00a0' : nextCharacter,
        track: null,
      };
    }
    return {
      className: `${rollTokenClass(nextCharacter)} is-rolling roll-${direction}`,
      text: null,
      track:
        direction === 'up'
          ? [previousCharacter, nextCharacter]
          : [nextCharacter, previousCharacter],
    };
  });
  return next;
}
