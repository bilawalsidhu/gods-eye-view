/** Render Radio state without making playback or Context decisions. */
import { t } from '../i18n/index.js';

const lifecycleWord = (lifecycleState) =>
  lifecycleState === 'enabling'
    ? t('radio.lifecycle.enabling')
    : t('radio.lifecycle.disabling');

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
  const enableText = transitioning
    ? lifecycleWord(lifecycleState)
    : t(
        uncertain
          ? 'radio.lifecycle.reconcile'
          : enabled
            ? 'common.disabled'
            : 'common.enabled',
      );
  const enableAria = t(
    uncertain
      ? 'radio.lifecycle.reconcileAria'
      : enabled
        ? 'radio.lifecycle.disableAria'
        : 'radio.lifecycle.enableAria',
  );
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
  if (this._radioLayerState) {
    this._radioLayerState.textContent = transitioning
      ? lifecycleWord(lifecycleState)
      : uncertain
        ? t('radio.layerState.uncertain')
        : state.loading
          ? t('radio.layerState.syncing')
          : enabled
            ? `${state.filteredCount}/${state.stationCount}`
            : t('common.off');
  }
  if (this._radioEnableBtn) {
    this._radioEnableBtn.classList.toggle('active', enabled);
    this._radioEnableBtn.setAttribute('aria-pressed', String(enabled));
    this._radioEnableBtn.textContent = enableText;
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
    this._contextRadioMiniEnableBtn.textContent = enableText;
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
    this._cockpitRadioEnableBtn.textContent = enableText;
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
          option.textContent = `● ${category.label} (${category.count})`;
          option.dataset.radioColor = category.color;
          option.style.color = category.color;
          option.setAttribute(
            'aria-label',
            `${category.label} (${category.count})`,
          );
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
        ? t('radio.tuner.directoryBand')
        : t('radio.tuner.categoryBand', {
            band: String(activeCategory?.label || state.filter).toUpperCase(),
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
      selected?.name || t('radio.station.none');
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
        t('radio.station.metadataOnly')
      : state.loading
        ? t('radio.station.loadingDirectory')
        : t('radio.station.pickHint');
  }
  if (this._radioStationTags) {
    const tags = Array.isArray(selected?.tags) ? selected.tags.slice(0, 8) : [];
    this._radioStationTags.textContent = tags.length
      ? t('radio.station.tags', { tags: tags.join(' · ') })
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
    ? t('common.pause')
    : state.audioState === 'paused'
      ? t('radio.transport.resume')
      : t('common.play');
  const playbackAria = t(
    selected ? 'radio.transport.playSelected' : 'radio.transport.playNearest',
    { action: playbackAction },
  );
  if (this._radioPlayBtn) {
    this._radioPlayBtn.disabled = !interactive || !hasStations;
    this._radioPlayBtn.classList.toggle('active', activePlayback);
    this._radioPlayBtn.textContent = playbackAction.toUpperCase();
    this._radioPlayBtn.setAttribute('aria-label', playbackAria);
  }
  if (this._contextRadioMiniPlayBtn) {
    this._contextRadioMiniPlayBtn.disabled = !interactive || !hasStations;
    this._contextRadioMiniPlayBtn.classList.toggle('active', activePlayback);
    this._contextRadioMiniPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
    this._contextRadioMiniPlayBtn.setAttribute('aria-label', playbackAria);
    this._contextRadioMiniPlayBtn.title = playbackAction;
  }
  if (this._cockpitRadioPlayBtn) {
    this._cockpitRadioPlayBtn.disabled = !interactive || !hasStations;
    this._cockpitRadioPlayBtn.classList.toggle('active', activePlayback);
    this._cockpitRadioPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
    this._cockpitRadioPlayBtn.setAttribute('aria-label', playbackAria);
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
      ? t('radio.mini.uncertain')
      : selected?.name ||
        (state.loading ? t('radio.mini.syncing') : t('radio.mini.ready'));
  }
  if (this._cockpitRadioStation) {
    this._cockpitRadioStation.textContent = uncertain
      ? t('radio.cockpit.uncertain')
      : selected?.name ||
        (state.loading ? t('radio.cockpit.syncing') : t('radio.cockpit.ready'));
  }
  if (this._radioPlaybackState) {
    const catalogSuffix = state.degraded
      ? state.stale
        ? t('radio.state.staleDegraded')
        : t('radio.state.degraded')
      : state.stale
        ? t('radio.state.stale')
        : '';
    const outsideFilter =
      selected && state.selectedIndex < 0 ? t('radio.state.outsideFilter') : '';
    const stationName = selected?.name || t('radio.station.fallbackName');
    const messages = {
      stopped: enabled ? t('radio.state.readyStopped') : t('radio.state.off'),
      loading: t('radio.state.connecting'),
      buffering: t('radio.state.buffering'),
      playing: t('radio.state.playing', { name: stationName }),
      paused: t('radio.state.paused', { name: stationName }),
      error: state.audioError || t('radio.state.broadcasterUnavailable'),
    };
    const voiceSuffix = state.voiceDucked
      ? t('radio.state.voiceDucked')
      : state.voiceRestoring
        ? t('radio.state.voiceRestoring')
        : '';
    const tuningSuffix = state.tuningAwaitingStationId
      ? state.audioState === 'error'
        ? t('radio.state.staticNoAudio')
        : t('radio.state.tuningStatic')
      : '';
    const unavailable = state.tuningUnavailableStationId
      ? t('radio.state.stationUnavailable')
      : null;
    const lifecycleMessage = transitioning
      ? lifecycleState === 'enabling'
        ? t('radio.lifecycle.enablingMessage')
        : t('radio.lifecycle.disablingMessage')
      : null;
    const uncertainMessage = uncertain
      ? t('radio.lifecycle.uncertainMessage')
      : null;
    this._radioPlaybackState.textContent = `${uncertainMessage || unavailable || lifecycleMessage || state.error || messages[state.audioState] || t('common.ready')}${tuningSuffix}${voiceSuffix}${catalogSuffix}${outsideFilter}`;
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
