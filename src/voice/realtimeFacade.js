/** Compatibility properties delegate to the owner that stores each value. */
export class RealtimeFacade {
  get visualizerAudioContext() {
    return this._input.visualizerAudioContext;
  }
  set visualizerAudioContext(value) {
    this._input.visualizerAudioContext = value;
  }
  get visualizerAnalyser() {
    return this._input.visualizerAnalyser;
  }
  set visualizerAnalyser(value) {
    this._input.visualizerAnalyser = value;
  }
  get visualizerSource() {
    return this._input.visualizerSource;
  }
  set visualizerSource(value) {
    this._input.visualizerSource = value;
  }
  get visualizerFrame() {
    return this._input.visualizerFrame;
  }
  set visualizerFrame(value) {
    this._input.visualizerFrame = value;
  }
  get visualizerData() {
    return this._input.visualizerData;
  }
  set visualizerData(value) {
    this._input.visualizerData = value;
  }
  get visualizerOutputSource() {
    return this._input.visualizerOutputSource;
  }
  set visualizerOutputSource(value) {
    this._input.visualizerOutputSource = value;
  }
  get visualizerOutputAnalyser() {
    return this._input.visualizerOutputAnalyser;
  }
  set visualizerOutputAnalyser(value) {
    this._input.visualizerOutputAnalyser = value;
  }
  get visualizerOutputData() {
    return this._input.visualizerOutputData;
  }
  set visualizerOutputData(value) {
    this._input.visualizerOutputData = value;
  }
  get visualizerSpeaker() {
    return this._input.visualizerSpeaker;
  }
  set visualizerSpeaker(value) {
    this._input.visualizerSpeaker = value;
  }
  get pushToTalkMode() {
    return this._input.pushToTalkMode;
  }
  set pushToTalkMode(value) {
    this._input.pushToTalkMode = value;
  }
  get pushToTalkKeyHeld() {
    return this._input.pushToTalkKeyHeld;
  }
  set pushToTalkKeyHeld(value) {
    this._input.pushToTalkKeyHeld = value;
  }
  get spaceKeyHeld() {
    return this._input.spaceKeyHeld;
  }
  set spaceKeyHeld(value) {
    this._input.spaceKeyHeld = value;
  }
  get pushToTalkHoldTimer() {
    return this._input.pushToTalkHoldTimer;
  }
  set pushToTalkHoldTimer(value) {
    this._input.pushToTalkHoldTimer = value;
  }
  get pushToTalkHoldGeneration() {
    return this._input.pushToTalkHoldGeneration;
  }
  set pushToTalkHoldGeneration(value) {
    this._input.pushToTalkHoldGeneration = value;
  }
  get pushToTalkHoldFocusOwner() {
    return this._input.pushToTalkHoldFocusOwner;
  }
  set pushToTalkHoldFocusOwner(value) {
    this._input.pushToTalkHoldFocusOwner = value;
  }
  get pushToTalkHoldControl() {
    return this._input.pushToTalkHoldControl;
  }
  set pushToTalkHoldControl(value) {
    this._input.pushToTalkHoldControl = value;
  }
  get pushToTalkHoldPreservesNative() {
    return this._input.pushToTalkHoldPreservesNative;
  }
  set pushToTalkHoldPreservesNative(value) {
    this._input.pushToTalkHoldPreservesNative = value;
  }
  get shortcutKeyDownHandler() {
    return this._input.shortcutKeyDownHandler;
  }
  set shortcutKeyDownHandler(value) {
    this._input.shortcutKeyDownHandler = value;
  }
  get shortcutKeyUpHandler() {
    return this._input.shortcutKeyUpHandler;
  }
  set shortcutKeyUpHandler(value) {
    this._input.shortcutKeyUpHandler = value;
  }
  get shortcutBlurHandler() {
    return this._input.shortcutBlurHandler;
  }
  set shortcutBlurHandler(value) {
    this._input.shortcutBlurHandler = value;
  }
  get shortcutVisibilityHandler() {
    return this._input.shortcutVisibilityHandler;
  }
  set shortcutVisibilityHandler(value) {
    this._input.shortcutVisibilityHandler = value;
  }
  get voiceTier() {
    return this._cost.voiceTier;
  }
  set voiceTier(value) {
    this._cost.voiceTier = value;
  }
  get voiceLimits() {
    return this._cost.voiceLimits;
  }
  set voiceLimits(value) {
    this._cost.voiceLimits = value;
  }
  get costTracker() {
    return this._cost.costTracker;
  }
  set costTracker(value) {
    this._cost.costTracker = value;
  }
  get costCapStopped() {
    return this._cost.costCapStopped;
  }
  set costCapStopped(value) {
    this._cost.costCapStopped = value;
  }
  get radioVoiceDucked() {
    return this._radio.radioVoiceDucked;
  }
  set radioVoiceDucked(value) {
    this._radio.radioVoiceDucked = value;
  }
  get pendingRadioPlaybackResult() {
    return this._radio.pendingRadioPlaybackResult;
  }
  set pendingRadioPlaybackResult(value) {
    this._radio.pendingRadioPlaybackResult = value;
  }
  get radioHandoffEpoch() {
    return this._radio.radioHandoffEpoch;
  }
  set radioHandoffEpoch(value) {
    this._radio.radioHandoffEpoch = value;
  }
  get radioHandoffCancellation() {
    return this._radio.radioHandoffCancellation;
  }
  set radioHandoffCancellation(value) {
    this._radio.radioHandoffCancellation = value;
  }
  get activeRadioToolControllers() {
    return this._radio.activeRadioToolControllers;
  }
  set activeRadioToolControllers(value) {
    this._radio.activeRadioToolControllers = value;
  }
  get radioHandoffInFlight() {
    return this._radio.radioHandoffInFlight;
  }
  set radioHandoffInFlight(value) {
    this._radio.radioHandoffInFlight = value;
  }
  get radioHandoffAttemptId() {
    return this._radio.radioHandoffAttemptId;
  }
  set radioHandoffAttemptId(value) {
    this._radio.radioHandoffAttemptId = value;
  }
  get radioHandoffInFlightResult() {
    return this._radio.radioHandoffInFlightResult;
  }
  set radioHandoffInFlightResult(value) {
    this._radio.radioHandoffInFlightResult = value;
  }
  get radioVisibilityOffReservation() {
    return this._radio.radioVisibilityOffReservation;
  }
  set radioVisibilityOffReservation(value) {
    this._radio.radioVisibilityOffReservation = value;
  }
  get radioVisibilityOffPending() {
    return this._radio.radioVisibilityOffPending;
  }
  set radioVisibilityOffPending(value) {
    this._radio.radioVisibilityOffPending = value;
  }
  get radioToolHandoffReservations() {
    return this._radio.radioToolHandoffReservations;
  }
  set radioToolHandoffReservations(value) {
    this._radio.radioToolHandoffReservations = value;
  }
  get radioHandoffDeferredByReservation() {
    return this._radio.radioHandoffDeferredByReservation;
  }
  set radioHandoffDeferredByReservation(value) {
    this._radio.radioHandoffDeferredByReservation = value;
  }
  get radioControlUnsubscribe() {
    return this._radio.radioControlUnsubscribe;
  }
  set radioControlUnsubscribe(value) {
    this._radio.radioControlUnsubscribe = value;
  }
  get radioVisibilityRequestUnsubscribe() {
    return this._radio.radioVisibilityRequestUnsubscribe;
  }
  set radioVisibilityRequestUnsubscribe(value) {
    this._radio.radioVisibilityRequestUnsubscribe = value;
  }
  get radioVisibilityUnsubscribe() {
    return this._radio.radioVisibilityUnsubscribe;
  }
  set radioVisibilityUnsubscribe(value) {
    this._radio.radioVisibilityUnsubscribe = value;
  }
  get debugSink() {
    return this._diagnostics.debugSink;
  }
  set debugSink(value) {
    this._diagnostics.debugSink = value;
  }
  get errors() {
    return this._diagnostics.errors;
  }
  set errors(value) {
    this._diagnostics.errors = value;
  }
  get sessionId() {
    return this._diagnostics.sessionId;
  }
  set sessionId(value) {
    this._diagnostics.sessionId = value;
  }
  get pendingViewportDeletes() {
    return this._viewport.pendingViewportDeletes;
  }
  set pendingViewportDeletes(value) {
    this._viewport.pendingViewportDeletes = value;
  }
  get lastViewportItemId() {
    return this._viewport.lastViewportItemId;
  }
  set lastViewportItemId(value) {
    this._viewport.lastViewportItemId = value;
  }
  get processedCalls() {
    return this._turns.processedCalls;
  }
  set processedCalls(value) {
    this._turns.processedCalls = value;
  }
  get responseActive() {
    return this._turns.responseActive;
  }
  set responseActive(value) {
    this._turns.responseActive = value;
  }
  get responseCreatePending() {
    return this._turns.responseCreatePending;
  }
  set responseCreatePending(value) {
    this._turns.responseCreatePending = value;
  }
  get userTurnPending() {
    return this._turns.userTurnPending;
  }
  set userTurnPending(value) {
    this._turns.userTurnPending = value;
  }
  get pendingResponseInstructions() {
    return this._turns.pendingResponseInstructions;
  }
  set pendingResponseInstructions(value) {
    this._turns.pendingResponseInstructions = value;
  }
  get pendingUserTextResponse() {
    return this._turns.pendingUserTextResponse;
  }
  set pendingUserTextResponse(value) {
    this._turns.pendingUserTextResponse = value;
  }
  get activeResponseId() {
    return this._turns.activeResponseId;
  }
  set activeResponseId(value) {
    this._turns.activeResponseId = value;
  }
  get supersededResponseIds() {
    return this._turns.supersededResponseIds;
  }
  set supersededResponseIds(value) {
    this._turns.supersededResponseIds = value;
  }
  get activeToolAbortControllers() {
    return this._turns.activeToolAbortControllers;
  }
  set activeToolAbortControllers(value) {
    this._turns.activeToolAbortControllers = value;
  }
  get connectionAbort() {
    return this._connection.connectionAbort;
  }
  set connectionAbort(value) {
    this._connection.connectionAbort = value;
  }
  get pc() {
    return this._connection.pc;
  }
  set pc(value) {
    this._connection.pc = value;
  }
  get dc() {
    return this._connection.dc;
  }
  set dc(value) {
    this._connection.dc = value;
  }
  get stream() {
    return this._connection.stream;
  }
  set stream(value) {
    this._connection.stream = value;
  }
  get audioEl() {
    return this._connection.audioEl;
  }
  set audioEl(value) {
    this._connection.audioEl = value;
  }
  get startEpoch() {
    return this._connection.startEpoch;
  }
  set startEpoch(value) {
    this._connection.startEpoch = value;
  }
  get disconnectGraceTimer() {
    return this._connection.disconnectGraceTimer;
  }
  set disconnectGraceTimer(value) {
    this._connection.disconnectGraceTimer = value;
  }
  get _tearingDown() {
    return this._connection._tearingDown;
  }
  set _tearingDown(value) {
    this._connection._tearingDown = value;
  }
  start(...args) {
    return this._connection.start(...args);
  }

  abandonStart(...args) {
    return this._connection.abandonStart(...args);
  }

  handleConnectionStateChange(...args) {
    return this._connection.handleConnectionStateChange(...args);
  }

  clearDisconnectGrace(...args) {
    return this._connection.clearDisconnectGrace(...args);
  }

  bindPushToTalkShortcut(...args) {
    return this._input.bindPushToTalkShortcut(...args);
  }

  cancelPushToTalkHold(...args) {
    return this._input.cancelPushToTalkHold(...args);
  }

  resetPushToTalkGesture(...args) {
    return this._input.resetPushToTalkGesture(...args);
  }

  releasePushToTalkKey(...args) {
    return this._input.releasePushToTalkKey(...args);
  }

  setMicrophoneEnabled(...args) {
    return this._input.setMicrophoneEnabled(...args);
  }

  startVoiceVisualizer(...args) {
    return this._input.startVoiceVisualizer(...args);
  }

  startAssistantVoiceVisualizer(...args) {
    return this._input.startAssistantVoiceVisualizer(...args);
  }

  stopVoiceVisualizer(...args) {
    return this._input.stopVoiceVisualizer(...args);
  }

  notifyMapEvent(...args) {
    return this._turns.notifyMapEvent(...args);
  }

  sendTextCommand(...args) {
    return this._turns.sendTextCommand(...args);
  }

  supersedeActiveResponseForUserTurn(...args) {
    return this._turns.supersedeActiveResponseForUserTurn(...args);
  }

  isSupersededResponse(...args) {
    return this._turns.isSupersededResponse(...args);
  }

  requestUserTextResponse(...args) {
    return this._turns.requestUserTextResponse(...args);
  }

  handleRealtimeEvent(...args) {
    return this._turns.handleRealtimeEvent(...args);
  }

  sendToolOutput(...args) {
    return this._turns.sendToolOutput(...args);
  }

  sendVisualContextIfUseful(...args) {
    return this._viewport.sendVisualContextIfUseful(...args);
  }

  updateVoiceButtonLabel(...args) {
    return this._input.updateVoiceButtonLabel(...args);
  }

  setVoiceSpeaker(...args) {
    return this._input.setVoiceSpeaker(...args);
  }

  pauseRadioForVoice(...args) {
    return this._radio.pauseRadioForVoice(...args);
  }

  setRadioVoiceDucking(...args) {
    return this._radio.setRadioVoiceDucking(...args);
  }

  reserveRadioVisibilityOff(...args) {
    return this._radio.reserveRadioVisibilityOff(...args);
  }

  isRadioHandoffReserved(...args) {
    return this._radio.isRadioHandoffReserved(...args);
  }

  freezeRadioHandoffForReservation(...args) {
    return this._radio.freezeRadioHandoffForReservation(...args);
  }

  reserveRadioToolHandoff(...args) {
    return this._radio.reserveRadioToolHandoff(...args);
  }

  settleRadioToolHandoffReservation(...args) {
    return this._radio.settleRadioToolHandoffReservation(...args);
  }

  resumeDeferredRadioHandoffIfUnreserved(...args) {
    return this._radio.resumeDeferredRadioHandoffIfUnreserved(...args);
  }

  startPendingRadioHandoff(...args) {
    return this._radio.startPendingRadioHandoff(...args);
  }

  abortRadioSiblingTools(...args) {
    return this._radio.abortRadioSiblingTools(...args);
  }

  cancelRadioHandoff(...args) {
    return this._radio.cancelRadioHandoff(...args);
  }

  sendRealtimeEvent(...args) {
    return this._connection.sendRealtimeEvent(...args);
  }

  reportError(...args) {
    return this._diagnostics.reportError(...args);
  }

  connectionDiagnostics(...args) {
    return this._diagnostics.connectionDiagnostics(...args);
  }

  getDiagnostics(...args) {
    return this._diagnostics.getDiagnostics(...args);
  }

  pruneProcessedCalls(...args) {
    return this._turns.pruneProcessedCalls(...args);
  }

  syncCostUi(...args) {
    return this._cost.syncCostUi(...args);
  }

  toggleVoiceTier(...args) {
    return this._cost.toggleVoiceTier(...args);
  }

  setVoiceTier(...args) {
    return this._cost.setVoiceTier(...args);
  }

  setVoiceCostLimits(...args) {
    return this._cost.setVoiceCostLimits(...args);
  }

  recordUsage(...args) {
    return this._cost.recordUsage(...args);
  }

  handleCostCap(...args) {
    return this._cost.handleCostCap(...args);
  }

  updateResponseState(...args) {
    return this._turns.updateResponseState(...args);
  }

  queueResponseCreate(...args) {
    return this._turns.queueResponseCreate(...args);
  }

  flushPendingResponse(...args) {
    return this._turns.flushPendingResponse(...args);
  }

  debugLog(...args) {
    return this._diagnostics.debugLog(...args);
  }
}
