import { createSequenceCones, thinImages } from '../../sequenceCones.js';
import { COLORS, PICK_PREFIX } from './policy.js';

export { thinImages } from '../../sequenceCones.js';

/** Normalize a graph image record into the shape the cones use. */
export function normalizeSequenceImage(record) {
  const coordinates = record?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  return {
    id: String(record.id),
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    compassAngle: Number(record.compass_angle) || 0,
    capturedAt: Number(record.captured_at) || 0,
    isPano: record.is_pano === true,
    altitude: Number.isFinite(record.computed_altitude)
      ? record.computed_altitude
      : null,
  };
}

/** Image cones for the selected Mapillary sequence, its line highlighted. */
export function createSequences({ state, source, parts }) {
  return createSequenceCones({
    state,
    async loadImages(sequenceId, { signal }) {
      const records = await source.getSequenceImages(sequenceId, { signal });
      return thinImages(
        records
          .map(normalizeSequenceImage)
          .filter(Boolean)
          .sort((a, b) => a.capturedAt - b.capturedAt),
      );
    },
    colors: COLORS,
    pickPrefix: PICK_PREFIX.image,
    spriteId: 'street-level:mapillary-cones',
    renderKey: 'mapillary-sequence',
    onHighlight: (sequenceId, selected) =>
      parts.coverage.recolorSequence(sequenceId, selected),
  });
}
