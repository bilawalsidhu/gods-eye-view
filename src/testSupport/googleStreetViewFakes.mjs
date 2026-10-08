/**
 * Stand-ins for the Google Maps JavaScript API's Street View library and the
 * loader that hands it out. Panoramas are {id: {lat, lng, imageDate,
 * copyright, description}}; `nearest(location, radius)` answers location
 * lookups with an id or null; `substitutes` maps an id Google answers with a
 * newer one. Like Google, `setPano` sets the id (pano_changed) at once, and
 * the position and status follow when the data arrives; status_changed fires
 * only when the status changes.
 */

function latLng(lat, lng) {
  return { lat: () => lat, lng: () => lng };
}

export function fakeStreetViewLibrary({
  panoramas = {},
  nearest = () => null,
  substitutes = {},
} = {}) {
  const built = [];
  const lookups = [];

  class StreetViewPanorama {
    constructor(element, options) {
      this.element = element;
      this.options = options;
      this.visible = options?.visible ?? true;
      this.pano = null;
      this.status = null;
      this.position = null;
      this.pov = { heading: 0, pitch: 0 };
      this.listeners = new Map();
      built.push(this);
    }

    addListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
      return { remove: () => this.listeners.get(name)?.delete(listener) };
    }

    fire(name) {
      for (const listener of [...(this.listeners.get(name) || [])]) listener();
    }

    listenerCount() {
      let count = 0;
      for (const set of this.listeners.values()) count += set.size;
      return count;
    }

    /** Like Google: the id is set at once; the data loads asynchronously. */
    setPano(id) {
      this.pano = id;
      this.fire('pano_changed');
      queueMicrotask(() => {
        if (this.pano !== id) return;
        const shownId = substitutes[id] ?? id;
        const known = panoramas[shownId];
        const status = known ? 'OK' : 'ZERO_RESULTS';
        if (shownId !== id) {
          this.pano = shownId;
          this.fire('pano_changed');
        }
        if (known) {
          this.position = latLng(known.lat, known.lng);
          this.fire('position_changed');
        }
        if (status !== this.status) {
          this.status = status;
          this.fire('status_changed');
        }
      });
    }

    getPano() {
      return this.pano;
    }

    getStatus() {
      return this.status;
    }

    getPosition() {
      return this.position;
    }

    getPov() {
      return { ...this.pov };
    }

    /** The user drags the view. */
    setPov(pov) {
      this.pov = { ...pov };
      this.fire('pov_changed');
    }

    setVisible(visible) {
      this.visible = visible;
    }
  }

  class StreetViewService {
    async getPanorama(request) {
      lookups.push(request);
      const id = request.pano ?? nearest(request.location, request.radius);
      const known = id && panoramas[id];
      if (!known)
        throw Object.assign(new Error('ZERO_RESULTS'), {
          code: 'ZERO_RESULTS',
        });
      return {
        data: {
          location: {
            pano: id,
            latLng: latLng(known.lat, known.lng),
            description: known.description,
          },
          imageDate: known.imageDate,
          copyright: known.copyright,
        },
      };
    }
  }

  return {
    library: {
      StreetViewPanorama,
      StreetViewService,
      StreetViewSource: { GOOGLE: 'google', OUTDOOR: 'outdoor' },
      StreetViewPreference: { NEAREST: 'nearest', BEST: 'best' },
    },
    built,
    lookups,
  };
}

/**
 * A loader over `library`; `refuseKey()` plays Google's gm_authFailure. With
 * `deferred`, imports wait for `release()`.
 */
export function fakeMapsLoader(library, { deferred = false } = {}) {
  let failed = false;
  const listeners = new Set();
  const imports = [];
  let release = null;
  const gate = deferred
    ? new Promise((resolve) => {
        release = resolve;
      })
    : null;
  return {
    imports,
    async importLibrary(name) {
      imports.push(name);
      await gate;
      return library;
    },
    release: () => release?.(),
    authFailed: () => failed,
    onAuthFailure(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refuseKey() {
      failed = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/** A host element with just what the viewer adapter touches. */
export function fakeHost() {
  const children = [];
  const host = {
    children,
    ownerDocument: {
      createElement: () => {
        const element = {
          style: {},
          className: '',
          remove() {
            const index = children.indexOf(element);
            if (index !== -1) children.splice(index, 1);
          },
        };
        return element;
      },
    },
    append: (element) => children.push(element),
  };
  return host;
}
