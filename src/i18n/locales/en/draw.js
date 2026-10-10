/**
 * Manual whiteboard drawing (DISPLAY ▸ Draw) hints and the annotation
 * engine's per-item failure strings. English values are verbatim.
 */
export default {
  hint: {
    pickShape: 'Pick a shape, then click the map.',
    pinPlace: 'Enter to place the pin, Esc to cancel.',
    pinClick: 'Click where the pin goes.',
    clickMore: {
      one: 'Click {count} more point.',
      other: 'Click {count} more points.',
    },
    areaDegenerate:
      'Those points are in a line — move one off it to enclose an area.',
    lineDegenerate: 'That line has no length — click somewhere further away.',
    finish:
      '{measure} · double-click or Enter to finish, Backspace undoes, Esc cancels.',
    limitReached: '{max}-point limit reached',
    full: 'That shape already has {max} points — finish it or press Backspace.',
    offGlobe: 'That point is off the globe — click on the world.',
    notPlaced: 'That shape could not be placed.',
    placeFailed: 'Could not place the shape: {error}',
    boardCleared: 'Board cleared.',
    pointerBusy: '{owner} is using the pointer — close it first.',
  },
  error: {
    unresolved: 'could not resolve location',
    limit: 'annotation limit reached',
    failed: 'annotation failed',
  },
};
