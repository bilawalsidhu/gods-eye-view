/**
 * Present Radio state without making playback or Context decisions: the
 * panel view renders the directory row, station card, transport, volume and
 * playback line, the Cockpit's compact radio controls and the directory
 * tuner from what this publishes (`gev-radio` store).
 */
import { t } from '../i18n/index.js';

export function renderRadioState(state) {
  if (this.destroyed || !state || !this._radioPanel) return;
  const lifecycle = this.actions.getLifecycle() || null;
  const lifecycleState =
    lifecycle?.lifecycleState || (state.enabled ? 'enabled' : 'disabled');
  state = {
    ...state,
    enabled: lifecycle ? lifecycle.enabled : state.enabled,
    lifecycleState,
    lifecycleUncertain: lifecycle?.uncertain || false,
  };
  this._radioState = state;
  const enabled = Boolean(state.enabled);
  const transitioning =
    lifecycleState === 'enabling' || lifecycleState === 'disabling';
  const uncertain = Boolean(state.lifecycleUncertain);
  const interactive = enabled && !transitioning && !uncertain;
  const selected = state.selected || null;
  const hasStations = state.filteredCount > 0;
  const activePlayback = ['loading', 'buffering', 'playing'].includes(
    state.audioState,
  );
  document
    .getElementById('title-bar')
    ?.classList.toggle('radio-broadcasting', state.audioState === 'playing');
  const lifecycleLabel =
    lifecycleState === 'enabling' ? t('ENABLING') : t('DISABLING');
  const layerStateText = transitioning
    ? lifecycleLabel
    : uncertain
      ? t('UNCERTAIN')
      : state.loading
        ? t('SYNC')
        : enabled
          ? `${state.filteredCount}/${state.stationCount}`
          : t('OFF');
  const enableLabel = uncertain
    ? t('RECONCILE')
    : enabled
      ? t('DISABLE')
      : t('ENABLE');
  const enableAria = uncertain
    ? t('Reconcile Radio — lifecycle uncertain')
    : enabled
      ? t('Disable Radio')
      : t('Enable Radio');

  const filter = state.filter || 'all';
  const categories = state.categories || [];
  // The options change only with the categories; until they first do, the
  // markup's own option stands.
  const categorySignature = categories
    .map(
      (category) =>
        `${category.id}:${category.label}:${category.count}:${category.color}`,
    )
    .join('|');
  if (categorySignature !== (this._radioCategorySignature ?? '')) {
    this._radioCategorySignature = categorySignature;
    this._radioFilterOptions = categories.map((category) => ({
      id: category.id,
      color: category.color,
      label: t('{category} ({count})', {
        category: category.label,
        count: category.count,
      }),
    }));
  }
  const filterColor =
    categories.find((category) => category.id === filter)?.color || '';

  const tunerAvailable = interactive && state.filteredCount > 0;
  const activeCategory = categories.find(
    (category) => category.id === state.filter,
  );
  showRadioTuner.call(this, {
    available: tunerAvailable,
    band:
      state.filter === 'all'
        ? t('DIRECTORY BAND')
        : t('{category} BAND', {
            category: String(
              activeCategory?.label || state.filter,
            ).toUpperCase(),
          }),
    static: Boolean(state.tuningStatic),
  });
  if (tunerAvailable) this._refreshRadioTunerBand?.();
  if (!tunerAvailable && this._radioTunerDragging) {
    this._radioTunerDragging = false;
    this._radioTunerDragSnapshot = null;
    this._radioTunerStations = [];
    showRadioTuner.call(this, { static: false, dragging: false });
  }
  if (!tunerAvailable) {
    this._radioTunerStations = [];
    this._radioTunerPool = [];
    this._radioTunerBandSignature = '';
    this._radioTunerSelectedId = null;
  }

  const place = selected
    ? [selected.state, selected.countryCode].filter(Boolean).join(' · ')
    : '';
  const signal = selected
    ? [selected.codec, selected.bitrate ? `${selected.bitrate} kbps` : '']
        .filter(Boolean)
        .join(' · ')
    : '';
  const stationMeta = selected
    ? [place, signal].filter(Boolean).join('  /  ') ||
      t('Directory metadata only')
    : state.loading
      ? t('Loading station directory…')
      : t('Choose a globe marker or use next.');
  const tags = Array.isArray(selected?.tags) ? selected.tags.slice(0, 8) : [];

  const playbackAction = activePlayback
    ? t('Pause')
    : state.audioState === 'paused'
      ? t('Resume')
      : t('Play');
  // The transport button is narrow: it gets its own short uppercase labels.
  const playbackButtonLabel = activePlayback
    ? t('PAUSE')
    : state.audioState === 'paused'
      ? t('RESUME')
      : t('PLAY');
  const playTargetWord = selected ? t('selected') : t('nearest');
  const playAria = t('{action} {target} radio station', {
    action: playbackAction,
    target: playTargetWord,
  });
  // A slider the person is dragging keeps the value they are setting.
  this._radioVolumeShown =
    this._radioVolume && document.activeElement === this._radioVolume
      ? Number(this._radioVolume.value)
      : Math.round(state.volume * 100);
  let playbackText = '';
  let playbackError = false;
  {
    const stationName = selected?.name || t('station');
    const catalogSuffix = state.degraded
      ? state.stale
        ? t(' · stale/degraded directory')
        : t(' · degraded directory')
      : state.stale
        ? t(' · stale directory')
        : '';
    const outsideFilter =
      selected && state.selectedIndex < 0 ? t(' · outside current filter') : '';
    const messages = {
      stopped: enabled
        ? t('Ready — playback starts only from your action')
        : t('Radio off'),
      loading: t('Connecting directly to broadcaster…'),
      buffering: t('Buffering broadcaster stream…'),
      playing: t('Playing {station}', { station: stationName }),
      paused: t('Paused {station}', { station: stationName }),
      // Playback keeps its messages in English (msg()); shown in the UI language.
      error: state.audioError
        ? t(state.audioError)
        : t('Broadcaster stream unavailable'),
    };
    const voiceSuffix = state.voiceDucked
      ? t(' · muted during voice interaction')
      : state.voiceRestoring
        ? t(' · restoring volume after voice')
        : '';
    const tuningSuffix = state.tuningAwaitingStationId
      ? state.audioState === 'error'
        ? t(' · static indicates no broadcaster audio')
        : t(' · tuning static until broadcaster starts')
      : '';
    const unavailable = state.tuningUnavailableStationId
      ? t(
          'Station unavailable after directory refresh — choose another channel',
        )
      : null;
    const lifecycleMessage = transitioning
      ? lifecycleState === 'enabling'
        ? t('Radio is enabling…')
        : t('Radio is disabling…')
      : null;
    const uncertainMessage = uncertain
      ? t('Radio lifecycle is uncertain — use Enable or Disable to reconcile')
      : null;
    // Directory errors are msg() literals from the radio layer's ingestion.
    const directoryError = state.error ? t(state.error) : null;
    playbackText = `${uncertainMessage || unavailable || lifecycleMessage || directoryError || messages[state.audioState] || t('Ready')}${tuningSuffix}${voiceSuffix}${catalogSuffix}${outsideFilter}`;
    playbackError = Boolean(
      uncertainMessage ||
      unavailable ||
      state.error ||
      state.audioState === 'error',
    );
  }
  const enable = {
    active: enabled,
    text: transitioning ? lifecycleLabel : enableLabel,
    label: enableAria,
    busy: transitioning,
  };
  this._radioView = {
    enabled,
    uncertain,
    layerState: { active: enabled, text: layerStateText },
    enable,
    filter: {
      options: this._radioFilterOptions ?? null,
      value: filter,
      color: filterColor,
      disabled: !interactive || !state.stationCount,
    },
    station: {
      name: selected?.name || t('NO STATION SELECTED'),
      meta: stationMeta,
      tags: tags.length ? t('TAGS · {tags}', { tags: tags.join(' · ') }) : '',
      homepage: selected?.homepage || '',
    },
    transport: {
      stepDisabled: !interactive || !hasStations,
      play: {
        disabled: !interactive || !hasStations,
        active: activePlayback,
        text: playbackButtonLabel,
        label: playAria,
      },
      stopDisabled: !interactive || state.audioState === 'stopped',
    },
    volume: { disabled: !interactive, value: this._radioVolumeShown },
    playback: { text: playbackText, error: playbackError },
    // The Cockpit's compact controls: a glyph transport and the layer's own
    // volume, which only a focused slider holds back.
    cockpit: {
      station: uncertain
        ? t('UNCERTAIN')
        : selected?.name || (state.loading ? t('SYNCING') : t('READY')),
      enable: { ...enable },
      // The rest of the transport is the panel's; the glyphs are the Cockpit's.
      play: { glyph: activePlayback ? 'Ⅱ' : '▶', title: playbackAction },
      volume: {
        disabled: !interactive,
        value: Math.round(state.volume * 100),
      },
    },
  };
  this.store?.publish(this._radioView);
  if (
    !enabled &&
    !transitioning &&
    !this.actions.preservePanelStateDuringClear() &&
    !this._radioPanel.classList.contains('collapsed')
  ) {
    this.actions.setPanelCollapsed('radio-panel', true);
  }
  this.actions.scheduleLayout();
}

/**
 * Show the volume the person is setting, on either slider, before the layer
 * reports it.
 * @param {number} value Percent, as the slider holds it.
 */
export function showRadioVolume(value) {
  this._radioVolumeShown = value;
  if (!this._radioView) return;
  const { volume, cockpit } = this._radioView;
  this._radioView = {
    ...this._radioView,
    volume: { ...volume, value },
    cockpit: { ...cockpit, volume: { ...cockpit.volume, value } },
  };
  this.store?.publish(this._radioView);
}

/** The tuner before RadioControls presents it; null texts keep the markup's. */
export function createRadioTunerState() {
  return {
    available: false,
    band: null,
    value: null,
    station: null,
    valuetext: null,
    // The slider's range and value.
    max: 0,
    slot: 0,
    // The needle's place across the dial, 0–1; null before the first preview.
    ratio: null,
    // The tick tape: the fractional station under the needle, and how many.
    coordinate: 0,
    count: 0,
    static: false,
    dragging: false,
  };
}

/**
 * Change what the tuner shows and publish it.
 * @param {Partial<ReturnType<typeof createRadioTunerState>>} changes
 */
export function showRadioTuner(changes) {
  this._radioTunerView = { ...this._radioTunerView, ...changes };
  this.store?.publishTuner({ ...this._radioTunerView });
}

/**
 * Mark an Enable button busy while its own toggle runs, as a render would
 * until the next one reports the lifecycle.
 * @param {boolean} busy
 * @param {'panel'|'cockpit'} [where] The panel's button or the Cockpit's.
 * @returns {boolean} False before the first render, when nothing is shown yet.
 */
export function showRadioEnableBusy(busy, where = 'panel') {
  if (!this._radioView) return false;
  const view = this._radioView;
  this._radioView =
    where === 'cockpit'
      ? {
          ...view,
          cockpit: {
            ...view.cockpit,
            enable: { ...view.cockpit.enable, busy },
          },
        }
      : { ...view, enable: { ...view.enable, busy } };
  this.store?.publish(this._radioView);
  return true;
}
