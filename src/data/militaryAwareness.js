import { createAwarenessLayer } from '../layers/awareness/index.js';
import flights from './flights.js';
import military from './militaryFlights.js';
import vessels from './aisLiveVessels.js';
import installations from './militaryInstallations.js';
import * as navigation from '../navigationPolicy.js';
import * as geometry from '../celestialRing.js';
import * as render from '../renderGovernor.js';

const layer = createAwarenessLayer({
  services: {
    flights,
    military,
    vessels,
    installations,
    navigation,
    geometry,
    render,
  },
});
export const contextTargetFlyToAllowed = layer.contextTargetFlyToAllowed;
export const awarenessClearMatchesSubject = layer.awarenessClearMatchesSubject;
export const awarenessRefreshIntervalMs = layer.awarenessRefreshIntervalMs;
export const awarenessRefreshDecision = layer.awarenessRefreshDecision;
export const awarenessClearIsEviction = layer.awarenessClearIsEviction;
export const awarenessRefreshRequired = layer.awarenessRefreshRequired;
export const summarizeInstallationViewport =
  layer.summarizeInstallationViewport;
export const contactsWindowFromSnapshot = layer.contactsWindowFromSnapshot;
export const buildAwarenessContextSnapshot =
  layer.buildAwarenessContextSnapshot;
export const collectAircraftProximityWindow =
  layer.collectAircraftProximityWindow;
export const _getAwarenessNavigationStateForTest =
  layer._getAwarenessNavigationStateForTest;
export const canNavigateAwarenessNext = layer.canNavigateAwarenessNext;
export const historySubjectSnapshot = layer.historySubjectSnapshot;
export const findCompatibleHistoryIndex = layer.findCompatibleHistoryIndex;
export const awarenessPanelControlKey = layer.awarenessPanelControlKey;
export const captureAwarenessPanelFocus = layer.captureAwarenessPanelFocus;
export const restoreAwarenessPanelFocus = layer.restoreAwarenessPanelFocus;
export const awarenessResultsAreLive = layer.awarenessResultsAreLive;
export const awarenessNeedsContinuousRender =
  layer.awarenessNeedsContinuousRender;
export { AWARENESS_QUERY_LIMIT } from '../layers/awareness/index.js';
export default layer;
