import { locationMiniStatus } from '../locationStatus.js';
const POI_KEYS = ['Q', 'W', 'E', 'R', 'T'];
const SCROLL_STEP_PX = 160;

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
    onAddPin = () => {},
    onRemovePin = () => {},
    onRenamePin = () => {},
    onResetPin = () => {},
    onAddPoi = () => {},
    onRenamePoi = () => {},
    onRemovePoi = () => {},
    isOverridden = () => false,
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
      onAddPin,
      onRemovePin,
      onRenamePin,
      onResetPin,
      onAddPoi,
      onRenamePoi,
      onRemovePoi,
      isOverridden,
      doc,
      requestFrame,
      cancelFrame,
    });
    this.removers = [];
    this.poiRemovers = [];
    this.frame = null;
    this.destroyed = false;
    this.rowGeneration = 0;
    this._pendingEdit = null;
    this.renderPills();
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

    // The pill row overflows on most screens once enough locations are
    // pinned; a plain mouse wheel doesn't natively scroll it horizontally,
    // and the scroll capability itself isn't otherwise discoverable.
    this.bind(elements.pills, 'wheel', (event) => {
      if (!event.deltaY || event.deltaX) return;
      event.preventDefault?.();
      elements.pills.scrollLeft =
        (elements.pills.scrollLeft || 0) + event.deltaY;
    });
    if (elements.pillsScrollLeft)
      this.bind(elements.pillsScrollLeft, 'click', () => {
        elements.pills.scrollLeft =
          (elements.pills.scrollLeft || 0) - SCROLL_STEP_PX;
      });
    if (elements.pillsScrollRight)
      this.bind(elements.pillsScrollRight, 'click', () => {
        elements.pills.scrollLeft =
          (elements.pills.scrollLeft || 0) + SCROLL_STEP_PX;
      });

    if (elements.addPin)
      this.bind(elements.addPin, 'click', () => {
        this.openEdit({ type: 'add-pin' }, '', 'Name this pin…');
      });
    if (elements.editInput)
      this.bind(elements.editInput, 'keydown', (event) => {
        if (event.key === 'Enter') this.commitEdit();
        else if (event.key === 'Escape') this.closeEdit();
      });
  }
  bind(element, event, handler, removers = this.removers) {
    if (!element) return;
    const listener = (...args) => {
      if (!this.destroyed) return handler(...args);
    };
    element.addEventListener(event, listener);
    removers.push(() => element.removeEventListener(event, listener));
  }
  /** Open the shared inline text input for one pending edit action. */
  openEdit(pending, prefillValue, placeholder) {
    if (this.destroyed || !this.elements.editInput) return;
    this._pendingEdit = pending;
    this.elements.editInput.value = prefillValue || '';
    this.elements.editInput.placeholder = placeholder || '';
    this.elements.editInput.classList.add('expanded');
    this.elements.editInput.focus();
  }
  closeEdit() {
    this._pendingEdit = null;
    if (!this.elements.editInput) return;
    this.elements.editInput.value = '';
    this.elements.editInput.classList.remove('expanded');
  }
  commitEdit() {
    const pending = this._pendingEdit;
    const value = this.elements.editInput?.value;
    this.closeEdit();
    if (!pending) return;
    if (pending.type === 'add-pin') this.onAddPin(value);
    else if (pending.type === 'rename-city')
      this.onRenamePin(pending.id, value);
    else if (pending.type === 'add-poi') this.onAddPoi(pending.id, value);
    else if (pending.type === 'rename-poi')
      this.onRenamePoi(pending.id, pending.poiIndex, value);
  }
  cancelExpansion() {
    this.rowGeneration++;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
  }
  /** (Re)build every pill from `this.cities`. Called on construction and after any edit. */
  renderPills() {
    const {
      doc,
      elements,
      cities,
      onCity,
      onRemovePin,
      onResetPin,
      isOverridden,
    } = this;
    elements.pills.replaceChildren();
    for (const [id, city] of Object.entries(cities)) {
      const pill = doc.createElement('button');
      pill.type = 'button';
      pill.className = 'location-pill';
      pill.dataset.locationId = id;
      pill.textContent = city.name;
      if (city.custom) pill.dataset.custom = 'true';
      this.bind(pill, 'click', () => onCity(id));

      // Edit controls are kept as siblings, never nested inside the pill
      // button itself — nesting interactive elements inside a <button> is
      // invalid HTML and would break the existing highlight/keyboard logic.
      const wrap = doc.createElement('span');
      wrap.className = 'location-pill-wrap';
      wrap.append(pill);

      const rename = doc.createElement('button');
      rename.type = 'button';
      rename.className = 'location-pill-rename';
      rename.ariaLabel = `Rename ${city.name}`;
      rename.title = `Rename ${city.name}`;
      rename.textContent = '✎';
      this.bind(rename, 'click', () =>
        this.openEdit(
          { type: 'rename-city', id },
          city.name,
          `Rename ${city.name}…`,
        ),
      );
      wrap.append(rename);

      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'location-pill-remove';
      remove.dataset.locationId = id;
      const removeLabel = city.custom
        ? `Delete ${city.name}`
        : `Hide ${city.name}`;
      remove.ariaLabel = removeLabel;
      remove.title = removeLabel;
      remove.textContent = '×';
      this.bind(remove, 'click', () => onRemovePin(id));
      wrap.append(remove);

      if (isOverridden(id)) {
        const reset = doc.createElement('button');
        reset.type = 'button';
        reset.className = 'location-pill-reset-btn';
        reset.ariaLabel = `Reset ${city.name} to default`;
        reset.title = `Reset ${city.name} to default`;
        reset.textContent = '↺';
        this.bind(reset, 'click', () => onResetPin(id));
        wrap.append(reset);
      }

      elements.pills.appendChild(wrap);
    }
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

      const wrap = this.doc.createElement('span');
      wrap.className = 'poi-pill-wrap';
      wrap.append(pill);

      const rename = this.doc.createElement('button');
      rename.type = 'button';
      rename.className = 'poi-pill-rename';
      rename.ariaLabel = `Rename ${poi.name}`;
      rename.title = `Rename ${poi.name}`;
      rename.textContent = '✎';
      this.bind(
        rename,
        'click',
        () =>
          this.openEdit(
            { type: 'rename-poi', id: cityId, poiIndex: index },
            poi.name,
            `Rename ${poi.name}…`,
          ),
        this.poiRemovers,
      );
      wrap.append(rename);

      if (city.pois.length > 1) {
        const remove = this.doc.createElement('button');
        remove.type = 'button';
        remove.className = 'poi-pill-remove';
        remove.ariaLabel = `Remove landmark ${poi.name}`;
        remove.title = `Remove landmark ${poi.name}`;
        remove.textContent = '×';
        this.bind(
          remove,
          'click',
          () => this.onRemovePoi(cityId, index),
          this.poiRemovers,
        );
        wrap.append(remove);
      }

      this.elements.poiRow.appendChild(wrap);
    });

    const addPoi = this.doc.createElement('button');
    addPoi.type = 'button';
    addPoi.className = 'poi-pill-add';
    addPoi.ariaLabel = `Add a landmark to ${city.name} at the current view`;
    addPoi.title = 'Add a landmark here';
    addPoi.textContent = '+';
    this.bind(
      addPoi,
      'click',
      () =>
        this.openEdit(
          { type: 'add-poi', id: cityId },
          '',
          'Name this landmark…',
        ),
      this.poiRemovers,
    );
    this.elements.poiRow.appendChild(addPoi);

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
