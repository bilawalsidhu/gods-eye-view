/** Render Radio state without making playback or Context decisions. */
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
  this._radioPanel.classList.toggle('radio-enabled', enabled);
  this._radioPanel.classList.toggle('lifecycle-uncertain', uncertain);
  this._contextRadioDock?.classList.toggle('active', enabled);
  if (this._contextRadioToggleBtn) {
    this._contextRadioToggleBtn.classList.toggle('active', enabled);
  }
  this._syncContextRadioLauncherState();
  this._radioLayerState?.classList.toggle('active', enabled);
  const lifecycleLabel =
    lifecycleState === 'enabling' ? t('ENABLING') : t('DISABLING');
  if (this._radioLayerState) {
    this._radioLayerState.textContent = transitioning
      ? lifecycleLabel
      : uncertain
        ? t('UNCERTAIN')
        : state.loading
          ? t('SYNC')
          : enabled
            ? `${state.filteredCount}/${state.stationCount}`
            : t('OFF');
  }
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
  if (this._radioEnableBtn) {
    this._radioEnableBtn.classList.toggle('active', enabled);
    this._radioEnableBtn.setAttribute('aria-pressed', String(enabled));
    this._radioEnableBtn.textContent = transitioning
      ? lifecycleLabel
      : enableLabel;
    this._radioEnableBtn.setAttribute('aria-label', enableAria);
    this._radioEnableBtn.disabled = false;
    this._radioEnableBtn.setAttribute('aria-disabled', String(transitioning));
    this._radioEnableBtn.setAttribute('aria-busy', String(transitioning));
  }
  if (this._contextRadioMiniEnableBtn) {
    this._contextRadioMiniEnableBtn.classList.toggle('active', enabled);
    this._contextRadioMiniEnableBtn.setAttribute(
      'aria-pressed',
      String(enabled),
    );
    this._contextRadioMiniEnableBtn.textContent = transitioning
      ? lifecycleLabel
      : enableLabel;
    this._contextRadioMiniEnableBtn.setAttribute('aria-label', enableAria);
    this._contextRadioMiniEnableBtn.disabled = false;
    this._contextRadioMiniEnableBtn.setAttribute(
      'aria-disabled',
      String(transitioning),
    );
    this._contextRadioMiniEnableBtn.setAttribute(
      'aria-busy',
      String(transitioning),
    );
  }
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

  if (this._radioFilter) {
    const prior = state.filter || 'all';
    const categorySignature = state.categories
      .map((category) => `${category.id}:${category.count}:${category.color}`)
      .join('|');
    if (categorySignature !== this._radioCategorySignature) {
      this._radioFilter.replaceChildren(
        ...state.categories.map((category) => {
          const option = document.createElement('option');
          option.value = category.id;
          const label = t('{category} ({count})', {
            category: category.label,
            count: category.count,
          });
          option.textContent = `● ${label}`;
          option.dataset.radioColor = category.color;
          option.style.color = category.color;
          option.setAttribute('aria-label', label);
          return option;
        }),
      );
      this._radioCategorySignature = categorySignature;
    }
    this._radioFilter.value = prior;
    const activeCategory = state.categories.find(
      (category) => category.id === prior,
    );
    this._radioFilter.style.color = activeCategory?.color || '';
    this._radioFilter.disabled = !interactive || !state.stationCount;
  }

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

  if (this._radioStationName)
    this._radioStationName.textContent =
      selected?.name || t('NO STATION SELECTED');
  if (this._radioStationMeta) {
    const place = selected
      ? [selected.state, selected.countryCode].filter(Boolean).join(' · ')
      : '';
    const signal = selected
      ? [selected.codec, selected.bitrate ? `${selected.bitrate} kbps` : '']
          .filter(Boolean)
          .join(' · ')
      : '';
    this._radioStationMeta.textContent = selected
      ? [place, signal].filter(Boolean).join('  /  ') ||
        t('Directory metadata only')
      : state.loading
        ? t('Loading station directory…')
        : t('Choose a globe marker or use next.');
  }
  if (this._radioStationTags) {
    const tags = Array.isArray(selected?.tags) ? selected.tags.slice(0, 8) : [];
    this._radioStationTags.textContent = tags.length
      ? t('TAGS · {tags}', { tags: tags.join(' · ') })
      : '';
  }
  if (this._radioStationHomepage) {
    const homepage = selected?.homepage || '';
    this._radioStationHomepage.hidden = !homepage;
    if (homepage) this._radioStationHomepage.href = homepage;
    else this._radioStationHomepage.removeAttribute('href');
  }

  if (this._radioPrevBtn)
    this._radioPrevBtn.disabled = !interactive || !hasStations;
  if (this._radioNextBtn)
    this._radioNextBtn.disabled = !interactive || !hasStations;
  if (this._contextRadioMiniPrevBtn)
    this._contextRadioMiniPrevBtn.disabled = !interactive || !hasStations;
  if (this._contextRadioMiniNextBtn)
    this._contextRadioMiniNextBtn.disabled = !interactive || !hasStations;
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
  if (this._radioPlayBtn) {
    this._radioPlayBtn.disabled = !interactive || !hasStations;
    this._radioPlayBtn.classList.toggle('active', activePlayback);
    this._radioPlayBtn.textContent = playbackButtonLabel;
    this._radioPlayBtn.setAttribute('aria-label', playAria);
  }
  if (this._contextRadioMiniPlayBtn) {
    this._contextRadioMiniPlayBtn.disabled = !interactive || !hasStations;
    this._contextRadioMiniPlayBtn.classList.toggle('active', activePlayback);
    this._contextRadioMiniPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
    this._contextRadioMiniPlayBtn.setAttribute('aria-label', playAria);
    this._contextRadioMiniPlayBtn.title = playbackAction;
  }
  if (this._cockpitRadioPlayBtn) {
    this._cockpitRadioPlayBtn.disabled = !interactive || !hasStations;
    this._cockpitRadioPlayBtn.classList.toggle('active', activePlayback);
    this._cockpitRadioPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
    this._cockpitRadioPlayBtn.setAttribute('aria-label', playAria);
    this._cockpitRadioPlayBtn.title = playbackAction;
  }
  if (this._radioStopBtn)
    this._radioStopBtn.disabled =
      !interactive || state.audioState === 'stopped';
  if (this._radioVolume) this._radioVolume.disabled = !interactive;
  if (this._radioVolume && document.activeElement !== this._radioVolume) {
    this._radioVolume.value = String(Math.round(state.volume * 100));
    if (this._radioVolumeValue)
      this._radioVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
  }
  if (
    this._contextRadioMiniVolume &&
    document.activeElement !== this._contextRadioMiniVolume
  ) {
    this._contextRadioMiniVolume.value = String(Math.round(state.volume * 100));
  }
  if (this._contextRadioMiniVolume)
    this._contextRadioMiniVolume.disabled = !interactive;
  if (this._contextRadioMiniVolumeValue) {
    this._contextRadioMiniVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
  }
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
  if (this._contextRadioMiniStation) {
    this._contextRadioMiniStation.textContent = uncertain
      ? t('RADIO STATE UNCERTAIN')
      : selected?.name ||
        (state.loading ? t('SYNCING DIRECTORY') : t('RADIO READY'));
  }
  if (this._cockpitRadioStation) {
    this._cockpitRadioStation.textContent = uncertain
      ? t('UNCERTAIN')
      : selected?.name || (state.loading ? t('SYNCING') : t('READY'));
  }
  if (this._radioPlaybackState) {
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
    this._radioPlaybackState.textContent = `${uncertainMessage || unavailable || lifecycleMessage || directoryError || messages[state.audioState] || t('Ready')}${tuningSuffix}${voiceSuffix}${catalogSuffix}${outsideFilter}`;
    this._radioPlaybackState.classList.toggle(
      'error',
      Boolean(
        uncertainMessage ||
        unavailable ||
        state.error ||
        state.audioState === 'error',
      ),
    );
  }
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
