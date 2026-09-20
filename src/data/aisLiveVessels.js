import { withBase } from '../services/apiBase.js';
import { createApplicationVessels } from '../app/layers/aisLiveVessels.js';

import { createAisStreamSource } from '../sources/live/standalone.js';

const aisLiveVesselsLayer = createApplicationVessels({
  source: createAisStreamSource({
    apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || withBase('/api/ais-live'),
  }),
  options: {
    maxRows: import.meta.env?.VITE_AIS_LIVE_MAX_ROWS,
    maxLabels: import.meta.env?.VITE_AIS_LIVE_LABEL_MAX_ROWS,
  },
});
export { AIS_FIRST_CONNECT_GRACE_MS } from '../layers/vessels/policy.js';
export const deriveAisFeedError = aisLiveVesselsLayer.deriveAisFeedError;
export const classifyAisFeedSnapshot =
  aisLiveVesselsLayer.classifyAisFeedSnapshot;
export const mapAnalystRecord = aisLiveVesselsLayer.mapAnalystRecord;
export const vesselDatumHeightM = aisLiveVesselsLayer.vesselDatumHeightM;
export const reduceVesselSelection = aisLiveVesselsLayer.reduceVesselSelection;
export const applyVesselFocusDeemphasis =
  aisLiveVesselsLayer.applyVesselFocusDeemphasis;
export const buildVesselCard = aisLiveVesselsLayer.buildVesselCard;
export const buildSelectedVesselCard =
  aisLiveVesselsLayer.buildSelectedVesselCard;
export const cardScreenSeparated = aisLiveVesselsLayer.cardScreenSeparated;
export const _bindVesselInteractionForTest =
  aisLiveVesselsLayer.testing._bindVesselInteractionForTest;
export const _setVesselStateForTest =
  aisLiveVesselsLayer.testing._setVesselStateForTest;
export const _setVesselOverlayHostForTest =
  aisLiveVesselsLayer.testing._setVesselOverlayHostForTest;
export const _updateVesselCardsForTest =
  aisLiveVesselsLayer.testing._updateVesselCardsForTest;
export const _reconcileVesselsForTest =
  aisLiveVesselsLayer.testing._reconcileVesselsForTest;
export const _applyAisFeedSnapshotForTest =
  aisLiveVesselsLayer.testing._applyAisFeedSnapshotForTest;
export const _loadLivePositionsForTest =
  aisLiveVesselsLayer.testing._loadLivePositionsForTest;
export const _beginAisSessionForTest =
  aisLiveVesselsLayer.testing._beginAisSessionForTest;
export const _setAisRuntimeForTest =
  aisLiveVesselsLayer.testing._setAisRuntimeForTest;
export const _getVesselFeedStateForTest =
  aisLiveVesselsLayer.testing._getVesselFeedStateForTest;
export const _getVesselStateForTest =
  aisLiveVesselsLayer.testing._getVesselStateForTest;
export default aisLiveVesselsLayer;
