import { locationMiniStatus } from '../locationStatus.js';
import { t } from '../i18n/index.js';
import { localizePlaceName } from './placeNames.js';

const POI_KEYS = ['Q', 'W', 'E', 'R', 'T'];

/**
 * locationStatus.js placeholder lines, built by the module itself; renderStatus
 * swaps them for translated text. Place names are shown as they are.
 */
const LOCATION_MINI_EMPTY = Object.freeze(locationMiniStatus());
const LOCATION_MINI_SEARCHED_PLACEHOLDER = Object.freeze(
  locationMiniStatus({ searchedLabel: '·' }),
);

/**
 * The location tray's presentation, keyboard handling and pending row
 * animation over supplied actions. The city pills, the landmark row, the
 * mini status and the search error are presented as a plain view and handed
 * to `publish`; Core's dock renders them and calls `chooseCity()` and
 * `choosePoi()`. The search field and reset buttons keep their listeners.
 */
export class LocationControls {
  constructor({
    elements,
    cities,
    getExpandedCity,
    onCity,
    onPoi,
    onSearch,
    onSearchEdit,
    onReset,
    publish = () => {},
    doc = document,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
  }) {
    Object.assign(this, {
      elements,
      cities,
      getExpandedCity,
      onCity,
      onPoi,
      onSearch,
      onReset,
      publish,
      doc,
      requestFrame,
      cancelFrame,
    });
    this.removers = [];
    this.frame = null;
    this.destroyed = false;
    this.rowGeneration = 0;
    this.activeCity = null;
    this.poiCity = null;
    this.activePoi = null;
    this.poisExpanded = false;
    this.status = {
      city: t('📍 Location: --'),
      poi: t('Landmark: --'),
    };
    this.searchError = null;
    this.bind(doc, 'keydown', (event) => {
      const cityId = getExpandedCity();
      if (
        !cityId ||
        event.target?.matches?.('select, input, textarea') ||
        event.target === elements.search
      )
        return;
      const index = POI_KEYS.indexOf(event.key.toUpperCase());
      if (index !== -1 && index < (cities[cityId]?.pois.length || 0))
        onPoi(cityId, index);
    });
    this.bind(elements.searchToggle, 'click', () => {
      elements.search.classList.toggle('expanded');
      if (elements.search.classList.contains('expanded'))
        elements.search.focus();
    });
    this.bind(elements.search, 'keydown', (event) => {
      if (event.key === 'Enter') void onSearch(elements.search.value);
    });
    // Typing corrects a failed query; closing the field (which empties it) drops its error.
    this.bind(elements.search, 'input', () => onSearchEdit?.());
    this.bind(elements.search, 'blur', () => {
      if (!elements.search.value) onSearchEdit?.();
    });
    for (const button of elements.resetButtons)
      this.bind(button, 'click', onReset);
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
  /** Publish the tray as it stands. */
  present() {
    if (this.destroyed) return;
    const pois = this.cities[this.poiCity]?.pois || [];
    this.publish({
      cities: Object.entries(this.cities).map(([id, city]) => ({
        id,
        label: localizePlaceName(city.name),
        active: id === this.activeCity,
      })),
      poiCity: this.poiCity,
      pois: pois.map((poi, index) => ({
        index,
        key: String(POI_KEYS[index] || index + 1),
        name: String(poi.name ?? ''),
        active: index === this.activePoi,
      })),
      poisExpanded: this.poisExpanded,
      status: { ...this.status },
      searchError: this.searchError,
    });
  }
  /** A city pill was clicked. */
  chooseCity(id) {
    if (!this.destroyed) this.onCity(id);
  }
  /** A landmark pill of the shown city was clicked. */
  choosePoi(index) {
    if (!this.destroyed && this.poiCity !== null)
      this.onPoi(this.poiCity, index);
  }
  cancelExpansion() {
    this.rowGeneration++;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
  }
  showPois(cityId) {
    if (this.destroyed) return;
    const city = this.cities[cityId];
    if (!city) return;
    this.cancelExpansion();
    const generation = this.rowGeneration;
    this.poiCity = cityId;
    this.activePoi = null;
    this.present();
    // The row expands a frame after its pills render, so the transition runs.
    this.frame = this.requestFrame(() => {
      if (this.destroyed || generation !== this.rowGeneration) return;
      this.frame = null;
      this.poisExpanded = true;
      this.present();
    });
  }
  hidePois() {
    if (this.destroyed) return;
    this.cancelExpansion();
    this.poisExpanded = false;
    this.present();
  }
  highlightPoi(index) {
    if (this.destroyed) return;
    this.activePoi = index;
    this.present();
  }
  highlightCity(id) {
    if (this.destroyed) return;
    this.activeCity = id;
    this.present();
  }
  renderStatus(record) {
    if (this.destroyed) return;
    // A preset city shows its name in the UI language; the record stays English.
    const state = record?.city?.name
      ? {
          ...record,
          city: { ...record.city, name: localizePlaceName(record.city.name) },
        }
      : record;
    const lines = locationMiniStatus(state);
    this.status = {
      city:
        lines.city === LOCATION_MINI_EMPTY.city
          ? t('📍 Location: --')
          : lines.city,
      poi:
        lines.poi === LOCATION_MINI_EMPTY.poi
          ? t('Landmark: --')
          : lines.poi === LOCATION_MINI_SEARCHED_PLACEHOLDER.poi
            ? t('Searched location')
            : lines.poi,
    };
    this.present();
  }
  /** Show, or with null clear, the announced error under the search field. */
  setSearchError(message) {
    if (this.destroyed) return;
    this.searchError = message || null;
    this.present();
  }
  createOrbitIndicator() {
    if (this.destroyed) return null;
    if (!this.orbitIndicator) {
      this.orbitIndicator = this.doc.createElement('div');
      this.orbitIndicator.id = 'orbit-indicator';
      const icon = this.doc.createElement('span');
      icon.className = 'orbit-icon';
      icon.textContent = '↻';
      this.orbitIndicator.append(icon, ` ${t('ORBIT')}`);
      this.doc.body.appendChild(this.orbitIndicator);
    }
    return this.orbitIndicator;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelExpansion();
    for (const remove of this.removers.splice(0)) remove();
    this.orbitIndicator?.remove();
  }
}
