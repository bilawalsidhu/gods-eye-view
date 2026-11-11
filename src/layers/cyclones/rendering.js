// Which advisory geometry the cyclone display draws (render/display.js).

/** Only geometry from the displayed status advisory is eligible for rendering. */
export function coherentCycloneGeometry(storm) {
  return (
    storm.geometryStatus === 'current' &&
    storm.geometryAdvisoryNumber === storm.advisoryNumber
  );
}
