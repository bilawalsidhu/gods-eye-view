const DISCONNECT_GRACE_MS = 6000;

function releaseStartResources({ localStream = null, localPc = null } = {}) {
  if (localStream) {
    try {
      localStream.getTracks().forEach((track) => track.stop());
    } catch {
      /* no-op */
    }
  }
  if (localPc) {
    try {
      localPc.close();
    } catch {
      /* no-op */
    }
  }
}
/** Own connection generations, negotiated transport and acquired media resources. */
export class RealtimeConnection {
  constructor({
    readLifetimeSignal,
    readBackend,
    readStatus,
    input,
    cost,
    operations,
  }) {
    Object.assign(
      this,
      { readLifetimeSignal, readBackend, readStatus, input, cost },
      operations,
    );
    this.connectionAbort = null;
    this.pc = null;
    this.dc = null;
    this.stream = null;
    this.audioEl = null;
    this.startEpoch = 0;
    this.disconnectGraceTimer = null;
    this._tearingDown = false;
  }
  get lifetimeSignal() {
    return this.readLifetimeSignal();
  }
  get backend() {
    return this.readBackend();
  }
  get status() {
    return this.readStatus();
  }
  async start({ pushToTalk = false } = {}) {
    if (this.isActive() || this.lifetimeSignal?.aborted) return;
    this.pauseRadioForVoice();
    const pushToTalkKeyHeld = pushToTalk && this.input.pushToTalkKeyHeld;
    const spaceKeyHeld = this.input.spaceKeyHeld;
    this.stop({ preserveStatus: true });
    this.input.pushToTalkMode = pushToTalk;
    this.input.pushToTalkKeyHeld = pushToTalkKeyHeld;
    this.input.spaceKeyHeld = spaceKeyHeld;
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      this.setStatus('error', 'WebRTC microphone support unavailable');
      return;
    }

    // Claim this connect attempt. stop() (and any later start()) bump startEpoch,
    // so `epoch !== this.startEpoch` after any await means we were superseded and
    // must abandon this attempt, releasing whatever it already acquired (H7).
    if (this.lifetimeSignal?.aborted) return;
    const epoch = ++this.startEpoch;
    this.connectionAbort?.abort();
    this.connectionAbort = new AbortController();
    const signal = AbortSignal.any(
      [this.connectionAbort.signal, this.lifetimeSignal].filter(Boolean),
    );
    // A new session is a new meter. Re-read tier + limits so a toggle made
    // while the last session ran (or in another tab) takes effect exactly here
    // — this is what "applies next session" means.
    this.cost.prepareSession();
    this.syncCostUi();
    this.setStatus('connecting', 'Requesting microphone');
    this.debugLog('session.starting', {
      epoch,
      tier: this.cost.voiceTier,
      connection: this.connectionDiagnostics(),
    });
    let localStream = null;
    let localPc = null;
    try {
      const minted = await this.backend.requestToken({
        tier: this.cost.voiceTier,
        signal,
      });
      const token = minted.token;
      if (this.abandonStart(epoch, { localStream, localPc })) return;
      // Bind the session meter to the model actually served. An env override
      // (OPENAI_REALTIME_MODEL[_MINI]) can point a tier at a different model,
      // and pricing by the tier we asked for would then under-meter and let the
      // cap be overrun. Unrecognised ids bill at worst-case rates.
      const costState = this.cost.bindServedModel(minted.model);
      if (!costState.ratesRecognized) {
        console.warn(
          `[GEV voice] unrecognised Realtime model "${costState.modelId}" — ` +
            'billing this session at the most expensive known rates. Update the ' +
            'rate table in src/voice/voiceCost.js.',
        );
      }
      this.syncCostUi();
      this.debugLog('session.token.ready', {
        hasToken: Boolean(token),
        servedModel: minted.model || null,
        servedTier: minted.tier || null,
        ratesRecognized: costState.ratesRecognized,
      });
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (this.abandonStart(epoch, { localStream, localPc })) return;
      this.stream = localStream;
      this.setMicrophoneEnabled(
        !this.input.pushToTalkMode || this.input.pushToTalkKeyHeld,
      );
      this.startVoiceVisualizer(localStream);

      document
        .querySelectorAll('audio[data-gev-realtime-audio="true"]')
        .forEach((el) => el.remove());
      this.audioEl = document.createElement('audio');
      this.audioEl.autoplay = true;
      this.audioEl.dataset.gevRealtimeAudio = 'true';
      this.audioEl.style.display = 'none';
      document.body.appendChild(this.audioEl);

      localPc = new RTCPeerConnection();
      this.pc = localPc;
      const ownsConnection = () =>
        epoch === this.startEpoch && this.pc === localPc && !signal.aborted;
      this.pc.ontrack = (event) => {
        if (!ownsConnection() || !this.audioEl) return;
        const remoteStream = event.streams[0];
        this.audioEl.srcObject = remoteStream;
        this.startAssistantVoiceVisualizer(remoteStream);
      };
      this.pc.onconnectionstatechange = () => {
        if (ownsConnection()) this.handleConnectionStateChange();
      };
      this.pc.oniceconnectionstatechange = () => {
        if (ownsConnection() && this.pc?.iceConnectionState === 'failed') {
          this.fatalError('ICE connection', null, this.connectionDiagnostics());
        }
      };
      this.pc.onicecandidateerror = (event) => {
        if (!ownsConnection()) return;
        this.reportError('ICE candidate', event, {
          errorCode: event.errorCode,
          errorText: event.errorText,
          address: event.address,
          port: event.port,
          url: event.url,
          ...this.connectionDiagnostics(),
        });
      };
      this.stream
        .getTracks()
        .forEach((track) => this.pc.addTrack(track, this.stream));

      const dataChannel = this.pc.createDataChannel('oai-events');
      this.dc = dataChannel;
      const ownsChannel = () => ownsConnection() && this.dc === dataChannel;
      dataChannel.addEventListener('open', () => {
        if (!ownsChannel()) return;
        const detail = this.input.pushToTalkMode
          ? this.input.pushToTalkKeyHeld
            ? 'Release Space to send'
            : 'Hold Space to talk'
          : 'Ask or command';
        this.setStatus('listening', detail);
        this.debugLog('data_channel.open', {
          connection: this.connectionDiagnostics(dataChannel),
        });
      });
      dataChannel.addEventListener('message', (event) => {
        if (ownsChannel() && dataChannel.readyState === 'open')
          return this.handleRealtimeEvent(event);
      });
      dataChannel.addEventListener('error', (event) => {
        // Skip if we're mid-teardown (the close we triggered) — otherwise a real
        // channel error tears the session down so the mic doesn't stay live (H8).
        if (this._tearingDown || !ownsChannel()) return;
        this.fatalError(
          'Realtime data channel',
          event,
          this.connectionDiagnostics(dataChannel),
        );
      });
      dataChannel.addEventListener('close', () => {
        if (this._tearingDown || !ownsChannel()) return;
        if (
          this.dc === dataChannel &&
          this.status !== 'idle' &&
          this.status !== 'error'
        ) {
          this.fatalError(
            'Realtime data channel closed',
            null,
            this.connectionDiagnostics(dataChannel),
          );
        }
      });

      const offer = await localPc.createOffer();
      if (this.abandonStart(epoch, { localStream, localPc })) return;
      await localPc.setLocalDescription(offer);
      if (this.abandonStart(epoch, { localStream, localPc })) return;
      this.debugLog('webrtc.offer.created', {
        sdpLength: offer.sdp?.length || 0,
        connection: this.connectionDiagnostics(),
      });
      const answerSdp = await this.backend.negotiate({
        offerSdp: offer.sdp,
        credential: minted,
        signal,
      });
      if (this.abandonStart(epoch, { localStream, localPc })) return;
      await localPc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });
      if (this.abandonStart(epoch, { localStream, localPc })) return;
      this.debugLog('webrtc.answer.applied', {
        connection: this.connectionDiagnostics(),
      });
    } catch (error) {
      // A superseded attempt should die quietly — its resources are already
      // released by abandonStart / the newer start(), and surfacing its error
      // would clobber the live session's status (H7).
      if (epoch !== this.startEpoch) {
        releaseStartResources({ localStream, localPc });
        return;
      }
      const diagnostics = this.connectionDiagnostics();
      this.stop({ preserveStatus: true });
      this.reportError('Realtime connection', error, diagnostics);
    }
  }

  // Returns true (and tears down the just-acquired resources) when this start()
  // attempt has been superseded by a newer start()/stop() — the caller must
  // then `return` immediately without touching shared session state (H7).
  abandonStart(epoch, resources) {
    if (epoch === this.startEpoch) return false;
    // These resources may or may not have been promoted onto `this` yet. If a
    // stop() bumped the epoch it already tore down whatever was promoted; if a
    // *second* start() bumped it, that start owns `this.stream`/`this.pc` now,
    // so only null the refs that still point at OUR abandoned locals — never the
    // successor's. Then release the locals unconditionally (idempotent close).
    if (resources.localStream && this.stream === resources.localStream)
      this.stream = null;
    if (resources.localPc && this.pc === resources.localPc) {
      this.pc = null;
      this.dc = null;
    }
    releaseStartResources(resources);
    this.debugLog('session.start.abandoned', {
      epoch,
      currentEpoch: this.startEpoch,
    });
    return true;
  }

  // WebRTC connection-state transitions. 'failed' is a hard drop → fatal. But
  // 'disconnected' is often a momentary blip ICE recovers from on its own, so we
  // give it a grace window; only if it hasn't recovered do we escalate to fatal.
  // A recovery to 'connected'/'completed' cancels the pending escalation (H8).
  handleConnectionStateChange() {
    const state = this.pc?.connectionState;
    if (state === 'failed') {
      this.fatalError('WebRTC connection', null, this.connectionDiagnostics());
      return;
    }
    if (state === 'disconnected') {
      if (this.disconnectGraceTimer) return;
      this.debugLog('webrtc.disconnected.grace', {
        graceMs: DISCONNECT_GRACE_MS,
        connection: this.connectionDiagnostics(),
      });
      this.disconnectGraceTimer = setTimeout(() => {
        this.disconnectGraceTimer = null;
        // Still not recovered after the grace window → treat as a real drop.
        if (this.pc?.connectionState === 'disconnected') {
          this.fatalError(
            'WebRTC connection lost',
            null,
            this.connectionDiagnostics(),
          );
        }
      }, DISCONNECT_GRACE_MS);
      return;
    }
    if (state === 'connected' || state === 'completed') {
      // Recovered before the grace window elapsed — cancel the escalation.
      this.clearDisconnectGrace();
    }
  }

  clearDisconnectGrace() {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
  }

  sendRealtimeEvent(message, logEventName = 'client.event') {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    this.debugLog(logEventName, {
      type: message?.type || null,
      message,
    });
    // A dc.send() that exceeds the SCTP send-buffer / max message size throws.
    // If that throw escaped it would abort handleRealtimeEvent BEFORE
    // queueResponseCreate + setStatus('listening'), stranding the turn at
    // EXECUTING. Swallow it and signal failure so callers can fall through
    // without the offending payload (M13).
    try {
      this.dc.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.debugLog('client.send.failed', {
        logEventName,
        type: message?.type || null,
        error: error?.message || String(error),
      });
      return false;
    }
  }

  invalidate() {
    this.startEpoch++;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
  }

  closeTransport() {
    if (this.dc) {
      try {
        this.dc.close();
      } catch {
        /* no-op */
      }
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* no-op */
      }
      this.pc = null;
    }
    this._tearingDown = false;
  }

  releaseMedia() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioEl) {
      this.audioEl.remove();
      this.audioEl = null;
    }
  }

  beginTeardown() {
    this._tearingDown = true;
  }
}
