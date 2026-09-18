import { defaultSurface } from './surfaceServices.js';
import { createApplicationRadio } from '../app/layers/radio.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createRadioSource } from '../layers/radio/source.js';

const sourceSlot = createSourceSlot(
  createRadioSource(),
  ['getDirectory', 'recordClick'],
  'Radio source',
);
export const configureRadioSource = sourceSlot.configure;
const layer = createApplicationRadio({
  surface: defaultSurface,
  source: sourceSlot.source,
});
export const radioGlobeLabel = layer.radioGlobeLabel;
export const createRadioSelectedOverlayEntry =
  layer.createRadioSelectedOverlayEntry;
export const createRadioClusterOverlayEntry =
  layer.createRadioClusterOverlayEntry;
export const createRadioSingletonOverlayEntry =
  layer.createRadioSingletonOverlayEntry;
export const radioSingletonLabelLimit = layer.radioSingletonLabelLimit;
export const selectRadioSingletonCandidates =
  layer.selectRadioSingletonCandidates;
export const selectRadioClusterCandidates = layer.selectRadioClusterCandidates;
export const reconcileRadioClusterCandidates =
  layer.reconcileRadioClusterCandidates;
export const radioCameraPositionChanged = layer.radioCameraPositionChanged;
export const normalizeRadioTag = layer.normalizeRadioTag;
export const stationMatchesRadioCategory = layer.stationMatchesRadioCategory;
export const radioCategoryColor = layer.radioCategoryColor;
export const radioClusterBadgeText = layer.radioClusterBadgeText;
export const radioClusterCategoryId = layer.radioClusterCategoryId;
export const radioSelectionBracketSvg = layer.radioSelectionBracketSvg;
export const radioStationCategoryId = layer.radioStationCategoryId;
export const buildRadioCategories = layer.buildRadioCategories;
export const filterRadioStations = layer.filterRadioStations;
export const isEnglishRadioStation = layer.isEnglishRadioStation;
export const rankRadioStationsForViewport = layer.rankRadioStationsForViewport;
export const rankRadioStationsForRequest = layer.rankRadioStationsForRequest;
export const radioViewIsGlobal = layer.radioViewIsGlobal;
export const radioRequestIsCurrent = layer.radioRequestIsCurrent;
export const radioStationIdFromPick = layer.radioStationIdFromPick;
export const radioStationCameraPlan = layer.radioStationCameraPlan;
export const radioGlobeNeedsRecentering = layer.radioGlobeNeedsRecentering;
export const radioGlobeRecenterHeight = layer.radioGlobeRecenterHeight;
export const buildRadioTunerBand = layer.buildRadioTunerBand;
export const radioTuningStaticShouldPlay = layer.radioTuningStaticShouldPlay;
export const getRadioAcceptedCatalogSnapshot =
  layer.getRadioAcceptedCatalogSnapshot;
export const radioStationResolutionMatches =
  layer.radioStationResolutionMatches;
export const getRadioUIState = layer.getRadioUIState;
export const subscribeToRadio = layer.subscribeToRadio;
export const subscribeToRadioPlaybackControls =
  layer.subscribeToRadioPlaybackControls;
export const getRadioTunerStations = layer.getRadioTunerStations;
export const beginRadioTuning = layer.beginRadioTuning;
export const setRadioTuningStatic = layer.setRadioTuningStatic;
export const radioCameraNavigationAllowed = layer.radioCameraNavigationAllowed;
export const previewRadioTuningStation = layer.previewRadioTuningStation;
export const endRadioTuning = layer.endRadioTuning;
export const cancelRadioTuning = layer.cancelRadioTuning;
export const commitRadioTuningStation = layer.commitRadioTuningStation;
export const playSelectedRadio = layer.playSelectedRadio;
export const confirmRadioPlayback = layer.confirmRadioPlayback;
export const playPreparedRadioForVoice = layer.playPreparedRadioForVoice;
export const stopRadioPlayback = layer.stopRadioPlayback;
export const toggleRadioPlayback = layer.toggleRadioPlayback;
export const pauseRadioPlayback = layer.pauseRadioPlayback;
export const setRadioVolume = layer.setRadioVolume;
export const setRadioParams = layer.setRadioParams;
export const getRadioParams = layer.getRadioParams;
export const setRadioVoiceDucking = layer.setRadioVoiceDucking;
export const selectRadioStation = layer.selectRadioStation;
export const cycleRadioStation = layer.cycleRadioStation;
export const selectRequestedRadioStation = layer.selectRequestedRadioStation;
export const setRadioFilter = layer.setRadioFilter;
export const retainRadioClusterIdentitiesForStations =
  layer.retainRadioClusterIdentitiesForStations;
export {
  RADIO_OVERLAY_SOURCE_ID,
  RADIO_OVERLAY_COHORT_LIMIT,
  RADIO_SINGLETON_GLOBAL_LIMIT,
  RADIO_SINGLETON_MID_LIMIT,
  RADIO_SINGLETON_NEAR_LIMIT,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
  RADIO_GLOBE_RECENTER_MAX_HEIGHT_M,
  RADIO_OVERLAY_SOURCE_OPTIONS,
  DEFAULT_RADIO_FILTER,
  GLOBAL_RADIO_ALTITUDE_M,
} from '../layers/radio/index.js';
export default layer;

export const radioLayer = layer;
export {
  radioTunerSlot,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
  buildRadioTunerTicks,
} from '../ui/radioTunerModel.js';
