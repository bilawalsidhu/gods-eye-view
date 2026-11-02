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
export const getRadioUIState = layer.getRadioUIState;
export const radioCameraNavigationAllowed = layer.radioCameraNavigationAllowed;
export const confirmRadioPlayback = layer.confirmRadioPlayback;
export const setRadioVolume = layer.setRadioVolume;
export const setRadioParams = layer.setRadioParams;
export const setRadioVoiceDucking = layer.setRadioVoiceDucking;
export const retainRadioClusterIdentitiesForStations =
  layer.retainRadioClusterIdentitiesForStations;
export {
  RADIO_OVERLAY_SOURCE_ID,
  RADIO_OVERLAY_COHORT_LIMIT,
  RADIO_SINGLETON_GLOBAL_LIMIT,
  RADIO_SINGLETON_MID_LIMIT,
  RADIO_SINGLETON_NEAR_LIMIT,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
  RADIO_OVERLAY_SOURCE_OPTIONS,
  DEFAULT_RADIO_FILTER,
} from '../layers/radio/index.js';
export default layer;

export const radioLayer = layer;
export {
  radioTunerSlot,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
  buildRadioTunerTicks,
} from '../ui/radioTunerModel.js';
