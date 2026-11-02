import { createCatalogModel } from './catalogModel.js';
import { createLabels } from './labels.js';
import { createClustering } from './clustering.js';
import { createVolume } from './volume.js';
import { createNavigation } from './navigation.js';
import { createCategories } from './categories.js';
import { createModel } from './model.js';
import { createQueries } from './queries.js';
import { createInteraction } from './interaction.js';
import { createTuning } from './tuning.js';
import { createTuningNoise } from './tuningNoise.js';
import { createRendering } from './rendering.js';
import { createPresentation } from './presentation.js';
import { createPlayback } from './playback.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createIngestion } from './ingestion.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createRadioLayer({ services, source }) {
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.catalogModel = createCatalogModel(context);
  parts.labels = createLabels(context);
  parts.clustering = createClustering(context);
  parts.volume = createVolume(context);
  parts.navigation = createNavigation(context);
  parts.categories = createCategories(context);
  parts.model = createModel(context);
  parts.queries = createQueries(context);
  parts.interaction = createInteraction(context);
  parts.tuning = createTuning(context);
  parts.tuningNoise = createTuningNoise(context);
  parts.rendering = createRendering(context);
  parts.presentation = createPresentation(context);
  parts.playback = createPlayback(context);
  parts.selection = createSelection(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  parts.ingestion = createIngestion(context);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion?.methods,
    {
      radioGlobeLabel: parts.labels.radioGlobeLabel,
      createRadioSelectedOverlayEntry:
        parts.labels.createRadioSelectedOverlayEntry,
      createRadioClusterOverlayEntry:
        parts.labels.createRadioClusterOverlayEntry,
      createRadioSingletonOverlayEntry:
        parts.labels.createRadioSingletonOverlayEntry,
      radioSingletonLabelLimit: parts.clustering.radioSingletonLabelLimit,
      selectRadioSingletonCandidates:
        parts.clustering.selectRadioSingletonCandidates,
      selectRadioClusterCandidates:
        parts.clustering.selectRadioClusterCandidates,
      reconcileRadioClusterCandidates:
        parts.clustering.reconcileRadioClusterCandidates,
      radioCameraPositionChanged: parts.navigation.radioCameraPositionChanged,
      normalizeRadioTag: parts.categories.normalizeRadioTag,
      stationMatchesRadioCategory: parts.categories.stationMatchesRadioCategory,
      radioCategoryColor: parts.model.radioCategoryColor,
      radioClusterBadgeText: parts.model.radioClusterBadgeText,
      radioClusterCategoryId: parts.model.radioClusterCategoryId,
      radioSelectionBracketSvg: parts.labels.radioSelectionBracketSvg,
      radioStationCategoryId: parts.model.radioStationCategoryId,
      buildRadioCategories: parts.categories.buildRadioCategories,
      filterRadioStations: parts.categories.filterRadioStations,
      isEnglishRadioStation: parts.categories.isEnglishRadioStation,
      rankRadioStationsForViewport: parts.queries.rankRadioStationsForViewport,
      rankRadioStationsForRequest: parts.queries.rankRadioStationsForRequest,
      radioViewIsGlobal: parts.navigation.radioViewIsGlobal,
      radioRequestIsCurrent: parts.model.radioRequestIsCurrent,
      radioStationIdFromPick: parts.interaction.radioStationIdFromPick,
      radioStationCameraPlan: parts.navigation.radioStationCameraPlan,
      radioGlobeNeedsRecentering: parts.navigation.radioGlobeNeedsRecentering,
      radioGlobeRecenterHeight: parts.navigation.radioGlobeRecenterHeight,
      buildRadioTunerBand: parts.tuning.buildRadioTunerBand,
      radioTuningStaticShouldPlay:
        parts.tuningNoise.radioTuningStaticShouldPlay,
      getRadioAcceptedCatalogSnapshot:
        parts.presentation.getRadioAcceptedCatalogSnapshot,
      radioStationResolutionMatches: parts.model.radioStationResolutionMatches,
      getRadioUIState: parts.presentation.getRadioUIState,
      subscribeToRadio: parts.presentation.subscribeToRadio,
      subscribeToRadioPlaybackControls:
        parts.presentation.subscribeToRadioPlaybackControls,
      getRadioTunerStations: parts.tuning.getRadioTunerStations,
      beginRadioTuning: parts.tuning.beginRadioTuning,
      setRadioTuningStatic: parts.tuning.setRadioTuningStatic,
      radioCameraNavigationAllowed:
        parts.navigation.radioCameraNavigationAllowed,
      previewRadioTuningStation: parts.tuning.previewRadioTuningStation,
      endRadioTuning: parts.tuning.endRadioTuning,
      cancelRadioTuning: parts.tuning.cancelRadioTuning,
      commitRadioTuningStation: parts.tuning.commitRadioTuningStation,
      playSelectedRadio: parts.playback.playSelectedRadio,
      confirmRadioPlayback: parts.playback.confirmRadioPlayback,
      playPreparedRadioForVoice: parts.playback.playPreparedRadioForVoice,
      stopRadioPlayback: parts.playback.stopRadioPlayback,
      toggleRadioPlayback: parts.playback.toggleRadioPlayback,
      pauseRadioPlayback: parts.playback.pauseRadioPlayback,
      setRadioVolume: parts.volume.setRadioVolume,
      setRadioParams: parts.selection.setRadioParams,
      getRadioParams: parts.selection.getRadioParams,
      setRadioVoiceDucking: parts.volume.setRadioVoiceDucking,
      selectRadioStation: parts.selection.selectRadioStation,
      cycleRadioStation: parts.selection.cycleRadioStation,
      selectRequestedRadioStation: parts.selection.selectRequestedRadioStation,
      setRadioFilter: parts.selection.setRadioFilter,
      retainRadioClusterIdentitiesForStations:
        parts.clustering.retainRadioClusterIdentitiesForStations,
    },
  );
}
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
} from './policy.js';

export { createRadioSource } from './source.js';
export {
  radioTunerSlot,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
  buildRadioTunerTicks,
} from '../../ui/radioTunerModel.js';

export { normalizeRadioCountryInput } from '../../data/radioCountry.js';
