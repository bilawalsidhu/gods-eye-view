const POI_KEYS = ['Q', 'W', 'E', 'R', 'T'];

/**
 * The preset places' controls over supplied actions: the Omnibar's city and
 * landmark chips call `chooseCity()` and `choosePoi()`, Q-W-E-R-T flies to a
 * landmark of the city last chosen, and the Omnibar runs a place lookup
 * through `search()`. Whose landmarks are shown, the lookup's error and
 * whether it runs, and the ORBIT indicator are presented as a plain view and
 * handed to `publish`; the Omnibar and the scene chrome render them. The
 * globe actions and the cockpit call `reset()`.
 */
export class LocationControls {
  constructor({
    cities,
    getExpandedCity,
    onCity,
    onPoi,
    onSearch,
    onSearchEdit,
    onReset,
    publish = () => {},
    doc = document,
  }) {
    Object.assign(this, {
      cities,
      getExpandedCity,
      onCity,
      onPoi,
      onSearch,
      onSearchEdit,
      onReset,
      publish,
      doc,
    });
    this.removers = [];
    this.destroyed = false;
    this.poiCity = null;
    this.searchError = null;
    // Who ran the last lookup ('omnibar' unless a caller names itself); its
    // error is shown there.
    this.searchOrigin = null;
    this.searching = false;
    // The ORBIT indicator: null until the shell offers it, then whether the
    // camera orbits.
    this.orbit = null;
    this.bind(doc, 'keydown', (event) => {
      const cityId = getExpandedCity();
      if (
        !cityId ||
        event.target?.matches?.(
          'select, input, textarea, [contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      // As for the application shortcuts: Cmd+R, Ctrl+W, Alt+E and the like
      // belong to the browser and the system. Shift is not a chord.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const index = POI_KEYS.indexOf(event.key.toUpperCase());
      if (index !== -1 && index < (cities[cityId]?.pois.length || 0))
        onPoi(cityId, index);
    });
    this.present();
  }
  bind(element, event, handler, removers = this.removers) {
    if (!element) return;
    const listener = (...args) => {
      if (!this.destroyed) return handler(...args);
    };
    element.addEventListener(event, listener);
    removers.push(() => element.removeEventListener(event, listener));
  }
  /** Publish the controls as they stand. */
  present() {
    if (!this.destroyed) this.publish(this.presentation());
  }
  /** The controls as they stand. */
  presentation() {
    return {
      poiCity: this.poiCity,
      searchError: this.searchError,
      searching: this.searching,
      searchOrigin: this.searchOrigin,
      orbit: this.orbit && { ...this.orbit },
    };
  }
  /** Look a place up, flying to it when found. */
  search(query, { origin = 'omnibar' } = {}) {
    if (this.destroyed || !String(query || '').trim()) return false;
    this._requestedSearchOrigin = origin;
    try {
      return this.onSearch(query);
    } finally {
      this._requestedSearchOrigin = null;
    }
  }
  /** Editing the Omnibar's query clears its prior lookup error. */
  editSearch() {
    if (!this.destroyed && this.searchOrigin === 'omnibar')
      this.onSearchEdit?.();
  }
  /** A preset city was chosen. */
  chooseCity(id) {
    if (!this.destroyed) this.onCity(id);
  }
  /** A reset to the full globe view was asked for. */
  reset() {
    if (!this.destroyed) return this.onReset();
  }
  /** A landmark of the city whose landmarks are shown was chosen. */
  choosePoi(index) {
    if (!this.destroyed && this.poiCity !== null)
      this.onPoi(this.poiCity, index);
  }
  /** Show `cityId`'s landmarks. */
  showPois(cityId) {
    if (this.destroyed || !this.cities[cityId]) return;
    this.poiCity = cityId;
    this.present();
  }
  /** Show, or with null clear, the lookup's error. */
  setSearchError(message) {
    if (this.destroyed) return;
    this.searchError = message || null;
    this.present();
  }
  /** Mark whether a lookup runs. */
  setSearching(active) {
    if (this.destroyed) return;
    if (active && this._requestedSearchOrigin)
      this.searchOrigin = this._requestedSearchOrigin;
    this.searching = Boolean(active);
    this.present();
  }
  /** A lookup settled. */
  settleSearch() {
    if (this.destroyed) return;
    this.searching = false;
    this.present();
  }
  /** Offer the ORBIT indicator, lit while the camera orbits. */
  showOrbit(active = false) {
    if (this.destroyed) return;
    this.orbit = { active: Boolean(active) };
    this.present();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const remove of this.removers.splice(0)) remove();
    // The ORBIT indicator leaves with its owner.
    if (this.orbit) {
      this.orbit = null;
      this.publish(this.presentation());
    }
  }
}
