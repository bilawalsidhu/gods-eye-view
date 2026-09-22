import Hls from 'hls.js';

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
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
  }
  if (this._cctvLive) {
    this._cctvHls?.destroy();
    this._cctvHls = null;
    this._cctvLive.pause?.();
    this._cctvLive.removeAttribute('src');
    this._cctvLive.classList.remove('active');
    this._cctvLive.dataset.cameraId = '';
    this._cctvLive.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvLive(src, cameraId) {
  if (this.destroyed || !this._cctvLive || !src) return false;
  const live = this._cctvLive;
  const token = ++this._cctvFrameRequestToken;
  this._cctvHls?.destroy();
  this._cctvHls = null;
  live.pause?.();
  live.classList.remove('active');
  live.dataset.cameraId = cameraId;
  live.dataset.error = '';
  live.onloadeddata = () => {
    if (this.destroyed || token !== this._cctvFrameRequestToken) return;
    live.classList.add('active');
    this._cctvFrameWrap?.classList.add('has-frame');
    this._syncCctvSourceBadge(this._cctvState?.activeCamera, true);
    live.play().catch(() => {});
  };
  live.onerror = () => {
    if (this.destroyed || token !== this._cctvFrameRequestToken) return;
    live.dataset.error = 'true';
    live.classList.remove('active');
    this._syncCctvSourceBadge(this._cctvState?.activeCamera, true);
    const fallback = this._cctvState?.activeCamera?.frameUrl;
    if (fallback) this._queueCctvFrame(fallback, cameraId, false);
  };
  if (/\.m3u8(?:$|[?#])/i.test(src) && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    this._cctvHls = hls;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) live.onerror?.();
    });
    hls.loadSource(src);
    hls.attachMedia(live);
  } else {
    live.src = src;
  }
  live.load();
  return true;
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

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

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok) {
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
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.src = src;
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
  const kind = this._cctvLive?.classList.contains('active')
    ? 'LIVE'
    : String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
    ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
