import { locationMiniStatus } from '../locationStatus.js';
const POI_KEYS = ['Q', 'W', 'E', 'R', 'T'];

/** Location DOM, keyboard handling and pending row animation over supplied actions. */
export class LocationControls {
  constructor({
    elements,
    cities,
    getExpandedCity,
    onCity,
    onPoi,
    onSearch,
    onReset,
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
      doc,
      requestFrame,
      cancelFrame,
    });
    this.removers = [];
    this.poiRemovers = [];
    this.frame = null;
    this.destroyed = false;
    this.rowGeneration = 0;
    elements.pills.replaceChildren();
    for (const [id, city] of Object.entries(cities)) {
      const pill = doc.createElement('button');
      pill.type = 'button';
      pill.className = 'location-pill';
      pill.dataset.locationId = id;
      pill.textContent = city.name;
      this.bind(pill, 'click', () => onCity(id));
      elements.pills.appendChild(pill);
    }
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
    for (const button of elements.resetButtons)
      this.bind(button, 'click', onReset);
  }
  bind(element, event, handler, removers = this.removers) {
    if (!element) return;
    const listener = (...args) => {
      if (!this.destroyed) return handler(...args);
    };
    element.addEventListener(event, listener);
    removers.push(() => element.removeEventListener(event, listener));
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
    for (const remove of this.poiRemovers.splice(0)) remove();
    this.elements.poiRow.replaceChildren();
    city.pois.forEach((poi, index) => {
      const pill = this.doc.createElement('button');
      pill.type = 'button';
      pill.className = 'poi-pill';
      pill.dataset.poiIndex = index;
      const key = this.doc.createElement('span');
      key.className = 'poi-pill-key';
      key.textContent = POI_KEYS[index] || index + 1;
      const label = this.doc.createElement('span');
      label.className = 'poi-pill-name';
      label.textContent = poi.name;
      pill.append(key, label);
      this.bind(
        pill,
        'click',
        () => this.onPoi(cityId, index),
        this.poiRemovers,
      );
      this.elements.poiRow.appendChild(pill);
    });
    this.frame = this.requestFrame(() => {
      if (this.destroyed || generation !== this.rowGeneration) return;
      this.frame = null;
      this.elements.poiRow.classList.add('expanded');
      this.elements.divider.classList.add('visible');
    });
  }
  hidePois() {
    if (this.destroyed) return;
    this.cancelExpansion();
    this.elements.poiRow.classList.remove('expanded');
    this.elements.divider.classList.remove('visible');
  }
  highlightPoi(index) {
    if (this.destroyed) return;
    for (const pill of this.elements.poiRow.querySelectorAll('.poi-pill'))
      pill.classList.toggle('active', Number(pill.dataset.poiIndex) === index);
  }
  highlightCity(id) {
    if (this.destroyed) return;
    for (const pill of this.elements.pills.querySelectorAll('.location-pill'))
      pill.classList.toggle('active', pill.dataset.locationId === id);
  }
  renderStatus(state) {
    if (this.destroyed || !this.elements.statusCity || !this.elements.statusPoi)
      return;
    const lines = locationMiniStatus(state);
    this.elements.statusCity.textContent = lines.city;
    this.elements.statusPoi.textContent = lines.poi;
  }
  createOrbitIndicator() {
    if (this.destroyed) return null;
    if (!this.orbitIndicator) {
      this.orbitIndicator = this.doc.createElement('div');
      this.orbitIndicator.id = 'orbit-indicator';
      const icon = this.doc.createElement('span');
      icon.className = 'orbit-icon';
      icon.textContent = '↻';
      this.orbitIndicator.append(icon, ' ORBIT');
      this.doc.body.appendChild(this.orbitIndicator);
    }
    return this.orbitIndicator;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelExpansion();
    for (const remove of [
      ...this.poiRemovers.splice(0),
      ...this.removers.splice(0),
    ])
      remove();
    this.orbitIndicator?.remove();
  }
}
