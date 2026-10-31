/**
 * Present Radio state without making playback or Context decisions: the
 * panel view renders the directory row, station card, transport, volume and
 * playback line from what this publishes (`gev-radio` store); the tuner and
 * the Cockpit radio controls are still written here.
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
  const activePlayback = ['playing', 'buffering'].includes(state.audioState);
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
  if (this._cockpitRadioEnableBtn) {
    this._cockpitRadioEnableBtn.classList.toggle('active', enabled);
    this._cockpitRadioEnableBtn.setAttribute('aria-pressed', String(enabled));
    this._cockpitRadioEnableBtn.textContent = transitioning
      ? lifecycleLabel
      : enableLabel;
    this._cockpitRadioEnableBtn.setAttribute('aria-label', enableAria);
    this._cockpitRadioEnableBtn.disabled = false;
    this._cockpitRadioEnableBtn.setAttribute(
      'aria-disabled',
      String(transitioning),
    );
    this._cockpitRadioEnableBtn.setAttribute(
      'aria-busy',
      String(transitioning),
    );
  }

  const filter = state.filter || 'all';
  const categories = state.categories || [];
  // The options change only with the categories; until they first do, the
  // markup's own option stands.
  const categorySignature = categories
    .map((category) => `${category.id}:${category.count}:${category.color}`)
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
  if (this._radioTuner) this._radioTuner.hidden = !tunerAvailable;
  if (this._radioTunerSlider) this._radioTunerSlider.disabled = !tunerAvailable;
  if (this._radioTunerBandLabel) {
    const activeCategory = state.categories.find(
      (category) => category.id === state.filter,
    );
    this._radioTunerBandLabel.textContent =
      state.filter === 'all'
        ? t('DIRECTORY BAND')
        : t('{category} BAND', {
            category: String(
              activeCategory?.label || state.filter,
            ).toUpperCase(),
          });
  }
  this._radioTuner?.classList.toggle('is-static', Boolean(state.tuningStatic));
  if (tunerAvailable) this._refreshRadioTunerBand?.();
  if (!tunerAvailable && this._radioTunerDragging) {
    this._radioTunerDragging = false;
    this._radioTunerDragSnapshot = null;
    this._radioTunerStations = [];
    this._radioTuner?.classList.remove('is-static', 'is-dragging');
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

  if (this._cockpitRadioPrevBtn)
    this._cockpitRadioPrevBtn.disabled = !interactive || !hasStations;
  if (this._cockpitRadioNextBtn)
    this._cockpitRadioNextBtn.disabled = !interactive || !hasStations;
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
  if (this._cockpitRadioPlayBtn) {
    this._cockpitRadioPlayBtn.disabled = !interactive || !hasStations;
    this._cockpitRadioPlayBtn.classList.toggle('active', activePlayback);
    this._cockpitRadioPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
    this._cockpitRadioPlayBtn.setAttribute('aria-label', playAria);
    this._cockpitRadioPlayBtn.title = playbackAction;
  }
  // A slider the person is dragging keeps the value they are setting.
  this._radioVolumeShown =
    this._radioVolume && document.activeElement === this._radioVolume
      ? Number(this._radioVolume.value)
      : Math.round(state.volume * 100);
  if (
    this._cockpitRadioVolume &&
    document.activeElement !== this._cockpitRadioVolume
  ) {
    this._cockpitRadioVolume.value = String(Math.round(state.volume * 100));
  }
  if (this._cockpitRadioVolume)
    this._cockpitRadioVolume.disabled = !interactive;
  if (this._cockpitRadioVolumeValue) {
    this._cockpitRadioVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
  }
  if (this._cockpitRadioStation) {
    this._cockpitRadioStation.textContent = uncertain
      ? t('UNCERTAIN')
      : selected?.name || (state.loading ? t('SYNCING') : t('READY'));
  }
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
  this._radioView = {
    enabled,
    uncertain,
    layerState: { active: enabled, text: layerStateText },
    enable: {
      active: enabled,
      text: transitioning ? lifecycleLabel : enableLabel,
      label: enableAria,
      busy: transitioning,
    },
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
 * Show the volume the person is setting before the layer reports it.
 * @param {number} value Percent, as the slider holds it.
 */
export function showRadioVolume(value) {
  this._radioVolumeShown = value;
  if (!this._radioView) return;
  this._radioView = {
    ...this._radioView,
    volume: { ...this._radioView.volume, value },
  };
  this.store?.publish(this._radioView);
}

/**
 * Mark the panel's Enable button busy while its own toggle runs, as a render
 * would until the next one reports the lifecycle.
 * @param {boolean} busy
 * @returns {boolean} False before the first render, when nothing is shown yet.
 */
export function showRadioEnableBusy(busy) {
  if (!this._radioView) return false;
  this._radioView = {
    ...this._radioView,
    enable: { ...this._radioView.enable, busy },
  };
  this.store?.publish(this._radioView);
  return true;
}
