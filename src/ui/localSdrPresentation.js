/**
 * Pure presentation of the Local RTL-SDR card in the Radio panel. Receives the
 * receiver session snapshot and returns what each control should show.
 */

function formatGain(gain) {
  return gain === 'auto' || !Number.isFinite(gain) ? 'auto' : gain.toFixed(1);
}

function formatIq(state) {
  return Number.isFinite(state.iqLevelDbfs)
    ? `${state.iqLevelDbfs.toFixed(1)} dBFS`
    : '--';
}

function statusText(state) {
  const fmActive = state.mode === 'fm';
  const iqStatus =
    state.samplesPerSecond > 0
      ? `${(state.samplesPerSecond / 1_000_000).toFixed(2)} MS/s IQ`
      : 'waiting for IQ';
  const device = state.deviceLabel ? ` · ${state.deviceLabel}` : '';
  if (state.connected && !fmActive) {
    return `${state.message}${device} · ${iqStatus} · ${state.decodedMessages} messages`;
  }
  const detail = state.seeking
    ? state.seekMessage
    : state.seekMessage || state.message;
  if (state.connected && fmActive) {
    const workerStatus =
      state.workerBlocks > 0
        ? `DSP ${state.workerBlocks} blocks`
        : 'DSP waiting';
    const rfStatus = `RF ${formatIq(state)}`;
    const audioSignal = Number.isFinite(state.audioLevelDbfs)
      ? `${state.audioLevelDbfs.toFixed(1)} dBFS audio`
      : 'audio signal --';
    return `${detail}${device} · ${iqStatus} · ${workerStatus} · ${rfStatus} · ${audioSignal} · audio ${state.audioState}`;
  }
  return detail;
}

/**
 * Derive the card's control states from one receiver snapshot.
 * @param {object} state SdrController.getState() snapshot.
 * @returns {object} Control presentation.
 */
export function localSdrCardView(state) {
  const transitional =
    state.status === 'connecting' || state.status === 'tuning';
  const fmActive = state.mode === 'fm';
  const adsbActive = state.mode === 'adsb';
  const fmInteractive =
    state.connected && fmActive && state.status === 'streaming';
  return {
    connectionLabel: state.connected
      ? adsbActive
        ? `${state.aircraftHeard || 0} HEARD`
        : 'STREAMING'
      : String(state.status || 'idle').toUpperCase(),
    connectionActive: Boolean(state.connected),
    connectLabel: transitional
      ? String(state.status).toUpperCase()
      : state.connected
        ? 'DISCONNECT'
        : 'CONNECT',
    connectDisabled: transitional || !state.webUsbSupported,
    connectPressed: Boolean(state.connected),
    fmActive,
    adsbActive,
    modeDisabled: transitional,
    locateLabel:
      state.locationStatus === 'requesting'
        ? 'LOCATING…'
        : state.locationStatus === 'ready'
          ? 'LOCATED'
          : 'LOCATE',
    locateDisabled: state.locationStatus === 'requesting',
    locateActive: state.locationStatus === 'ready',
    changeDeviceDisabled: transitional || !state.webUsbSupported,
    gainValue: formatGain(state.gain),
    gainDisabled: transitional,
    statsHidden: !(adsbActive && state.connected),
    stats: {
      rate: Number.isFinite(state.messagesPerSecond)
        ? state.messagesPerSecond.toFixed(1)
        : '--',
      heard: String(state.aircraftHeard || 0),
      positioned: String(state.aircraftPositioned || 0),
      iq: formatIq(state),
    },
    frequencyDisabled: !fmActive || transitional,
    frequencyValue: fmActive
      ? (state.frequencyHz / 1_000_000).toFixed(1)
      : null,
    tuneDisabled: !state.connected || !fmActive || transitional,
    seekDisabled: !fmInteractive || Boolean(state.seeking),
    volumePercent: Math.round((Number(state.volume) || 0) * 100),
    volumeDisabled: !fmActive,
    statusText: statusText(state),
    statusError: state.status === 'error' || state.status === 'unsupported',
  };
}

/**
 * Whether the receiver is producing FM audio (the state that must not overlap
 * internet-radio playback).
 * @param {object} state SdrController.getState() snapshot.
 * @returns {boolean}
 */
export function localSdrFmAudioActive(state) {
  return Boolean(
    state?.connected && state.mode === 'fm' && state.status === 'streaming',
  );
}

/**
 * Whether internet radio is loading or playing a station.
 * @param {object} state Radio UI state.
 * @returns {boolean}
 */
export function internetRadioAudioActive(state) {
  return ['loading', 'buffering', 'playing'].includes(state?.audioState);
}
