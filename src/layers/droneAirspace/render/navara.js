import { droneAirspaceAccent } from '../cards.js';
import { createZonesNavaraRenderer } from '../../shared/render/navaraZones.js';

/** The FAA zones on Navara, as fire perimeters draw. */
export function createDroneAirspaceNavaraRenderer(engine, { view }) {
  return createZonesNavaraRenderer(
    engine,
    { view },
    {
      idPrefix: 'drone-airspace',
      colorOf: (row) => droneAirspaceAccent(row.typeCode),
    },
  );
}
