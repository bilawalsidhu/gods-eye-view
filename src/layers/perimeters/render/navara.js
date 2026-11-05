import { containmentAccent } from '../cards.js';
import { createZonesNavaraRenderer } from '../../shared/render/navaraZones.js';

export function createPerimetersNavaraRenderer(engine, { view }) {
  return createZonesNavaraRenderer(
    engine,
    { view },
    {
      idPrefix: 'fire-perimeter',
      colorOf: (row) => containmentAccent(row.containedPct),
    },
  );
}
