function fillSelect(select, entries, current, interactive) {
  if (!select) return;
  const wanted = entries.map((entry) => `${entry.id}|${entry.label}`).join(',');
  if (select.dataset.options !== wanted) {
    select.innerHTML = '';
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      select.appendChild(option);
    }
    select.dataset.options = wanted;
  }
  if (select.value !== current) select.value = current;
  select.disabled = !interactive;
}

/** Render Web Receivers state without making lifecycle or Context decisions. */
export function renderWebReceiversState(state) {
  if (this.destroyed || !state || !this._webReceiversPanel) return;
  const lifecycle = this.actions.getLifecycle() || null;
  const lifecycleState =
    lifecycle?.lifecycleState || (state.enabled ? 'enabled' : 'disabled');
  const enabled = lifecycle
    ? Boolean(lifecycle.enabled)
    : Boolean(state.enabled);
  const transitioning =
    lifecycleState === 'enabling' || lifecycleState === 'disabling';
  const uncertain = Boolean(lifecycle?.uncertain);
  const interactive = enabled && !transitioning && !uncertain;
  this._state = {
    ...state,
    enabled,
    lifecycleState,
    lifecycleUncertain: uncertain,
  };
  this._webReceiversPanel.classList.toggle('radio-enabled', enabled);
  this._webReceiversPanel.classList.toggle('lifecycle-uncertain', uncertain);
  this._webReceiversLayerState?.classList.toggle('active', enabled);
  if (this._webReceiversLayerState) {
    this._webReceiversLayerState.textContent = transitioning
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'UNCERTAIN'
        : state.loading
          ? 'SYNC'
          : enabled
            ? `${state.filteredCount}/${state.receiverCount}`
            : 'OFF';
  }
  if (this._webReceiversEnableBtn) {
    this._webReceiversEnableBtn.classList.toggle('active', enabled);
    this._webReceiversEnableBtn.setAttribute('aria-pressed', String(enabled));
    this._webReceiversEnableBtn.textContent = transitioning
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'RECONCILE'
        : enabled
          ? 'DISABLE'
          : 'ENABLE';
    this._webReceiversEnableBtn.setAttribute(
      'aria-label',
      uncertain
        ? 'Reconcile Web Receivers — lifecycle uncertain'
        : `${enabled ? 'Disable' : 'Enable'} Web Receivers`,
    );
    this._webReceiversEnableBtn.setAttribute(
      'aria-busy',
      String(transitioning),
    );
  }
  fillSelect(
    this._webReceiversType,
    state.filters?.types || [],
    state.filter?.type || 'all',
    interactive,
  );
  fillSelect(
    this._webReceiversBand,
    state.filters?.bands || [],
    state.filter?.band || 'all',
    interactive,
  );
  const receiver = state.selected;
  if (this._webReceiversName) {
    this._webReceiversName.textContent = receiver
      ? receiver.name.toUpperCase()
      : 'NO RECEIVER SELECTED';
  }
  if (this._webReceiversMeta) {
    if (receiver) {
      const slots =
        receiver.users !== null && receiver.usersMax !== null
          ? ` · ${receiver.users}/${receiver.usersMax} users${receiver.users >= receiver.usersMax ? ' (FULL)' : ''}`
          : '';
      const online = receiver.online === false ? ' · OFFLINE' : '';
      this._webReceiversMeta.textContent = `${receiver.typeLabel}${receiver.site ? ` · ${receiver.site}` : ''}${slots}${online}`;
    } else {
      this._webReceiversMeta.textContent = enabled
        ? 'Click a marker, or ask for receivers near a place.'
        : 'Enable Web Receivers, then click a marker — or ask for receivers near a place.';
    }
  }
  if (this._webReceiversBands) {
    this._webReceiversBands.textContent = receiver
      ? `${state.selectedBands}${receiver.antenna ? ` · ${receiver.antenna}` : ''}`
      : '';
  }
  const canTune = interactive && Boolean(receiver);
  for (const control of [
    this._webReceiversFreq,
    this._webReceiversMode,
    this._webReceiversTuneBtn,
    this._webReceiversOpenBtn,
    this._webReceiversSpecFrom,
    this._webReceiversSpecTo,
    this._webReceiversSpecBtn,
  ]) {
    if (control) control.disabled = !canTune;
  }
  const last = state.lastTune;
  if (
    this._webReceiversFreq &&
    last &&
    last.kind !== 'spectrum' &&
    !this._webReceiversFreq.value
  ) {
    this._webReceiversFreq.value = String(last.hz / 1000);
  }
  if (last?.kind === 'spectrum') {
    if (this._webReceiversSpecFrom && !this._webReceiversSpecFrom.value)
      this._webReceiversSpecFrom.value = String(last.lowHz / 1000);
    if (this._webReceiversSpecTo && !this._webReceiversSpecTo.value)
      this._webReceiversSpecTo.value = String(last.highHz / 1000);
  }
  // A selection survives disable; the status line must not keep saying "Tuned".
  if (this._webReceiversStatus && (!receiver || !enabled)) {
    this._webReceiversStatus.textContent = enabled
      ? state.loading
        ? 'Loading receiver directory…'
        : state.error
          ? state.error
          : `${state.filteredCount} receivers shown${state.stale ? ' (stale directory)' : ''}`
      : 'Web receivers off';
  }
  if (!enabled && this._webReceiversDock && !this._webReceiversDock.hidden)
    this._closeDock({ silent: true });
}
