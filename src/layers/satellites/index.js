import { createControls } from './controls.js';
import { createCatalog } from './catalog.js';
import { createCockpitSubject } from './cockpitSubject.js';
import { createLabels } from './labels.js';
import { createOrbits } from './orbits.js';
import { createRendering } from './rendering.js';
import { createTracking } from './tracking.js';
import { createTesting } from './testing.js';
import { createInteraction } from './interaction.js';
import { issStationDescription } from './issStation.js';
import { createStationPanel } from './stationPanel.js';
import { createIssModel } from './issModel.js';
import { createTiangongModel } from './tiangongModel.js';
import { tiangongStationDescription } from './tiangongStation.js';
import { createLifecycle } from './lifecycle.js';
import { createIngestion } from './ingestion.js';
import { createRecords } from './records.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createSatellitesLayer({
  services,
  source,
  resolveAsset = (url) => url,
}) {
  if (typeof source?.readGroup !== 'function')
    throw new TypeError('A satellites source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.controls = createControls(context);
  parts.catalog = createCatalog(context);
  parts.labels = createLabels(context);
  parts.orbits = createOrbits(context);
  parts.records = createRecords(context);
  parts.rendering = createRendering(context);
  // The stations drawn as models up close; the other parts ask
  // stationModels.js which station an entry belongs to.
  parts.issModel = createIssModel({ ...context, resolveAsset });
  parts.tiangongModel = createTiangongModel({ ...context, resolveAsset });
  parts.stationModels = [parts.issModel, parts.tiangongModel];
  parts.stationPanel = createStationPanel({
    ...context,
    stations: [
      issStationDescription(context),
      tiangongStationDescription(context),
    ],
  });
  parts.tracking = createTracking(context);
  parts.testing = createTesting(context);
  parts.interaction = createInteraction(context);
  parts.lifecycle = createLifecycle(context);
  parts.ingestion = createIngestion(context);
  parts.cockpit = createCockpitSubject(context);
  const layer = Object.assign(
    {},
    parts.controls.methods,
    parts.cockpit.methods,
    parts.stationPanel.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
    {
      createIssOverlayEntry: parts.labels.createIssOverlayEntry,
      getNextIssPass: parts.orbits.getNextIssPass,
      getNextSatellitePass: parts.orbits.getNextSatellitePass,
      resolveSatelliteForPass: parts.orbits.resolveSatelliteForPass,
      getAnalystRecords: parts.records.getAnalystRecords,
      findSatelliteOrbitTrackInTle: parts.orbits.findSatelliteOrbitTrackInTle,
      getSatelliteOrbitTrack: parts.orbits.getSatelliteOrbitTrack,
    },
  );
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  return layer;
}
export { ISS_OVERLAY_SOURCE_ID, ISS_OVERLAY_SOURCE_OPTIONS } from './policy.js';
export { createSatelliteSource } from './source.js';
