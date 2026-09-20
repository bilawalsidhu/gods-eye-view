/** Render Radio state without making playback or Context decisions. */
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
  if (this._radioLayerState) {
    this._radioLayerState.textContent = transitioning
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'UNCERTAIN'
        : state.loading
          ? 'SYNC'
          : enabled
            ? `${state.filteredCount}/${state.stationCount}`
            : 'OFF';
  }
  if (this._radioEnableBtn) {
    this._radioEnableBtn.classList.toggle('active', enabled);
    this._radioEnableBtn.setAttribute('aria-pressed', String(enabled));
    this._radioEnableBtn.textContent = transitioning
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'RECONCILE'
        : enabled
          ? 'DISABLE'
          : 'ENABLE';
    this._radioEnableBtn.setAttribute(
      'aria-label',
      uncertain
        ? 'Reconcile Radio — lifecycle uncertain'
        : `${enabled ? 'Disable' : 'Enable'} Radio`,
    );
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
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'RECONCILE'
        : enabled
          ? 'DISABLE'
          : 'ENABLE';
    this._contextRadioMiniEnableBtn.setAttribute(
      'aria-label',
      uncertain
        ? 'Reconcile Radio — lifecycle uncertain'
        : `${enabled ? 'Disable' : 'Enable'} Radio`,
    );
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
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'RECONCILE'
        : enabled
          ? 'DISABLE'
          : 'ENABLE';
    this._cockpitRadioEnableBtn.setAttribute(
      'aria-label',
      uncertain
        ? 'Reconcile Radio — lifecycle uncertain'
        : `${enabled ? 'Disable' : 'Enable'} Radio`,
    );
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
        ? 'DIRECTORY BAND'
        : `${String(activeCategory?.label || state.filter).toUpperCase()} BAND`;
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
      selected?.name || 'NO STATION SELECTED';
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
        'Directory metadata only'
      : state.loading
        ? 'Loading station directory…'
        : 'Choose a globe marker or use next.';
  }
  if (this._radioStationTags) {
    const tags = Array.isArray(selected?.tags) ? selected.tags.slice(0, 8) : [];
    this._radioStationTags.textContent = tags.length
      ? `TAGS · ${tags.join(' · ')}`
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
  if (this._radioPlayBtn) {
    const action = activePlayback
      ? 'Pause'
      : state.audioState === 'paused'
        ? 'Resume'
        : 'Play';
    this._radioPlayBtn.disabled = !interactive || !hasStations;
    this._radioPlayBtn.classList.toggle('active', activePlayback);
    this._radioPlayBtn.textContent = action.toUpperCase();
    this._radioPlayBtn.setAttribute(
      'aria-label',
      `${action} ${selected ? 'selected' : 'nearest'} radio station`,
    );
  }
  if (this._contextRadioMiniPlayBtn) {
    const action = activePlayback
      ? 'Pause'
      : state.audioState === 'paused'
        ? 'Resume'
        : 'Play';
    this._contextRadioMiniPlayBtn.disabled = !interactive || !hasStations;
    this._contextRadioMiniPlayBtn.classList.toggle('active', activePlayback);
    this._contextRadioMiniPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
    this._contextRadioMiniPlayBtn.setAttribute(
      'aria-label',
      `${action} ${selected ? 'selected' : 'nearest'} radio station`,
    );
    this._contextRadioMiniPlayBtn.title = action;
  }
  if (this._cockpitRadioPlayBtn) {
    const action = activePlayback
      ? 'Pause'
      : state.audioState === 'paused'
        ? 'Resume'
        : 'Play';
    this._cockpitRadioPlayBtn.disabled = !interactive || !hasStations;
    this._cockpitRadioPlayBtn.classList.toggle('active', activePlayback);
    this._cockpitRadioPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
    this._cockpitRadioPlayBtn.setAttribute(
      'aria-label',
      `${action} ${selected ? 'selected' : 'nearest'} radio station`,
    );
    this._cockpitRadioPlayBtn.title = action;
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
      ? 'RADIO STATE UNCERTAIN'
      : selected?.name || (state.loading ? 'SYNCING DIRECTORY' : 'RADIO READY');
  }
  if (this._cockpitRadioStation) {
    this._cockpitRadioStation.textContent = uncertain
      ? 'UNCERTAIN'
      : selected?.name || (state.loading ? 'SYNCING' : 'READY');
  }
  if (this._radioPlaybackState) {
    const catalogSuffix = state.degraded
      ? state.stale
        ? ' · stale/degraded directory'
        : ' · degraded directory'
      : state.stale
        ? ' · stale directory'
        : '';
    const outsideFilter =
      selected && state.selectedIndex < 0 ? ' · outside current filter' : '';
    const messages = {
      stopped: enabled
        ? 'Ready — playback starts only from your action'
        : 'Radio off',
      loading: 'Connecting directly to broadcaster…',
      buffering: 'Buffering broadcaster stream…',
      playing: `Playing ${selected?.name || 'station'}`,
      paused: `Paused ${selected?.name || 'station'}`,
      error: state.audioError || 'Broadcaster stream unavailable',
    };
    const voiceSuffix = state.voiceDucked
      ? ' · muted during voice interaction'
      : state.voiceRestoring
        ? ' · restoring volume after voice'
        : '';
    const tuningSuffix = state.tuningAwaitingStationId
      ? state.audioState === 'error'
        ? ' · static indicates no broadcaster audio'
        : ' · tuning static until broadcaster starts'
      : '';
    const unavailable = state.tuningUnavailableStationId
      ? 'Station unavailable after directory refresh — choose another channel'
      : null;
    const lifecycleMessage = transitioning
      ? lifecycleState === 'enabling'
        ? 'Radio is enabling…'
        : 'Radio is disabling…'
      : null;
    const uncertainMessage = uncertain
      ? 'Radio lifecycle is uncertain — use Enable or Disable to reconcile'
      : null;
    this._radioPlaybackState.textContent = `${uncertainMessage || unavailable || lifecycleMessage || state.error || messages[state.audioState] || 'Ready'}${tuningSuffix}${voiceSuffix}${catalogSuffix}${outsideFilter}`;
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
