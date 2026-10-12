/** One user-triggered device fix; coordinates are consumed only by map navigation. */
export class LocateControls {
  constructor({
    button,
    status,
    geolocation = globalThis.navigator?.geolocation,
    secure = globalThis.isSecureContext,
    begin,
    isCurrent,
    center,
    subscribeAuthority = () => () => {},
    lifecycleTarget = globalThis.window,
    gestureTarget,
  }) {
    Object.assign(this, {
      button,
      status,
      geolocation,
      secure,
      begin,
      isCurrent,
      center,
    });
    this.destroyed = false;
    this.pending = false;
    this.epoch = 0;
    this.onClick = () => this.locate();
    button?.addEventListener('click', this.onClick);
    this.unsubscribe = subscribeAuthority(() => {
      if (this.pending && !this.isCurrent(this.generation))
        this.cancel(
          'Location request canceled by another map action. Tap Locate me to try again.',
        );
    });
    this.lifecycleTarget = lifecycleTarget;
    this.onPagehide = () => this.cancel();
    lifecycleTarget?.addEventListener('pagehide', this.onPagehide);
    this.gestureTarget = gestureTarget;
    this.onGesture = () => {
      if (this.pending)
        this.cancel(
          'Location request canceled by a map gesture. Tap Locate me to try again.',
        );
    };
    gestureTarget?.addEventListener('pointerdown', this.onGesture, {
      passive: true,
    });
    gestureTarget?.addEventListener('wheel', this.onGesture, { passive: true });
  }
  render(state, message) {
    this.button?.setAttribute('aria-busy', String(state === 'loading'));
    this.button?.setAttribute('aria-disabled', String(state === 'loading'));
    if (this.button) {
      this.button.dataset.state = state;
      this.button.title =
        state === 'loading' ? 'Finding your location…' : 'Locate me';
    }
    if (this.status) {
      this.status.dataset.state = state;
      this.status.textContent = message;
      this.status.hidden = !message;
    }
    clearTimeout(this.messageTimer);
    if (state !== 'loading' && message && this.status)
      this.messageTimer = setTimeout(
        () => {
          if (!this.destroyed) this.status.hidden = true;
        },
        state === 'error' ? 12000 : 5000,
      );
  }
  cancel(message = '') {
    this.epoch++;
    this.pending = false;
    this.render(message ? 'error' : 'idle', message);
  }
  locate() {
    if (this.destroyed || this.pending) return;
    if (!this.secure) {
      this.render('error', 'Open the secure HTTPS app link to use Locate me.');
      return;
    }
    if (!this.geolocation?.getCurrentPosition) {
      this.render(
        'error',
        'Location is unavailable in this browser. Try a browser with location access.',
      );
      return;
    }
    const generation = this.begin();
    if (generation === false) {
      this.render('error', 'Exit cockpit to locate yourself on the map.');
      return;
    }
    this.generation = generation;
    const epoch = ++this.epoch;
    this.pending = true;
    this.render(
      'loading',
      'Finding your location. Allow location access if your browser asks.',
    );
    const current = () =>
      !this.destroyed &&
      this.pending &&
      epoch === this.epoch &&
      this.isCurrent(generation);
    const fail = (error) => {
      if (!current()) return;
      this.pending = false;
      const message =
        error?.code === 1
          ? 'Location permission denied. Allow location for this site in browser settings, then try again.'
          : error?.code === 3
            ? 'Location took too long. Check device Location is on, then try again.'
            : 'Location unavailable. Check device Location is on and try again.';
      this.render('error', message);
    };
    try {
      this.geolocation.getCurrentPosition(
        (position) => {
          if (!current()) return;
          const { latitude, longitude, accuracy } = position?.coords || {};
          if (
            !Number.isFinite(latitude) ||
            Math.abs(latitude) > 90 ||
            !Number.isFinite(longitude) ||
            Math.abs(longitude) > 180
          ) {
            fail({ code: 2 });
            return;
          }
          try {
            const centered = this.center(
              latitude,
              longitude,
              accuracy,
              generation,
            );
            this.pending = false;
            this.render(
              centered === false ? 'error' : 'ready',
              centered === false
                ? 'Location request canceled. Tap Locate me to try again.'
                : 'Map centered on your device location.',
            );
          } catch {
            fail({ code: 2 });
          }
        },
        fail,
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      );
    } catch {
      fail({ code: 2 });
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.cancel();
    this.destroyed = true;
    clearTimeout(this.messageTimer);
    this.unsubscribe?.();
    this.button?.removeEventListener('click', this.onClick);
    this.lifecycleTarget?.removeEventListener('pagehide', this.onPagehide);
    this.gestureTarget?.removeEventListener('pointerdown', this.onGesture);
    this.gestureTarget?.removeEventListener('wheel', this.onGesture);
  }
}
