/** Stop watching a live preview for its first frame. */
function stopLiveFrameWatch(ui) {
  clearInterval(ui._cctvLiveFrameWatch);
  ui._cctvLiveFrameWatch = 0;
  if (ui._cctvFrame) {
    ui._cctvFrame.onload = null;
    ui._cctvFrame.onerror = null;
  }
}

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  stopLiveFrameWatch(this);
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
    this._cctvFrame.dataset.live = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged, live = false) {
  if (this.destroyed || !this._cctvFrame || !src) return;
  stopLiveFrameWatch(this);

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  if (live) {
    // A live MJPEG stream never "finishes", and a preloader would hold a second
    // connection to the same camera. Stream straight into the preview element
    // and treat the first decoded frame as settled.
    if (this._cctvFramePreloader) this._cctvFramePreloader = null;
    const frame = this._cctvFrame;
    const startedAt = Date.now();
    const settle = (ok) => {
      stopLiveFrameWatch(this);
      this._settleCctvFrame(token, src, ok, true);
    };
    frame.onload = () => settle(true);
    frame.onerror = () => settle(false);
    this._cctvLiveFrameWatch = setInterval(() => {
      if (frame.naturalWidth > 0) settle(true);
      else if (Date.now() - startedAt > 20000) settle(false);
    }, 250);
    frame.src = src;
    return;
  }

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok, live = false) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen. A failed
    // live stream is released so it cannot keep retrying on its own.
    if (live) this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.dataset.live = live ? 'true' : '';
  // A live stream is already playing in the element; reassigning reconnects.
  if (!live) this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · LOADING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind =
    this._cctvFrame?.dataset.live === 'true'
      ? 'LIVE'
      : String(
          activeCamera.sourceKind || activeCamera.feedType || 'unknown',
        ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
