import * as Cesium from 'cesium';
import {
  AREA_METRICS,
  SERVICE_CATEGORIES,
  areaMetricScore,
  weightedAreaIndex,
  areaScoreColor,
  rankNearbyAreas,
} from '../data/areaAssessment.js';
import { createAreaAssessmentSource } from '../sources/areaAssessment.js';
import { AREA_COPY, areaPanelMarkup } from './areaAssessmentCopy.js';
import {
  setOverlayEntries,
  clearOverlaySource,
} from '../overlays/worldOverlay.js';

const serviceColors = {
  health: '#f472b6',
  education: '#60a5fa',
  food: '#c084fc',
  transit: '#22d3ee',
};
const storageKey = 'gev-area-assessment-v1';
const defaults = () =>
  Object.fromEntries(
    Object.keys(AREA_METRICS).map((id) => [id, { selected: true, weight: 1 }]),
  );
const format = (value) =>
  value == null
    ? '—'
    : Number(value).toLocaleString('en-GB', { maximumFractionDigits: 1 });
const scoreText = (score) => (score == null ? '—' : `${Math.round(score)}/100`);

/** Independent parameter controls, point sampling, map overlays and explicit partial coverage. */
export class AreaAssessmentControls {
  constructor(viewer, { source = createAreaAssessmentSource() } = {}) {
    this.viewer = viewer;
    this.source = source;
    this.selection = defaults();
    this.budgets = { 'EUR/m²': 4000, 'GBP/home': 300000, 'USD/home': 400000 };
    this.observations = {};
    this.comparedAreas = [];
    this.requests = new Map();
    this.entities = [];
    this.revision = 0;
    this.listeners = [];
    this.destroyed = false;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      for (const id of Object.keys(AREA_METRICS)) {
        const row = saved?.selection?.[id];
        if (
          typeof row?.selected === 'boolean' &&
          Number.isFinite(row.weight) &&
          row.weight >= 0 &&
          row.weight <= 5
        )
          this.selection[id] = { ...row };
      }
      for (const unit of Object.keys(this.budgets))
        if (Number.isFinite(saved?.budgets?.[unit]) && saved.budgets[unit] > 0)
          this.budgets[unit] = saved.budgets[unit];
    } catch {
      /* Preferences are optional. */
    }
    this.launcher = document.createElement('button');
    this.launcher.id = 'area-assessment-launcher';
    this.launcher.textContent = '◎ Area insights';
    this.launcher.setAttribute('aria-controls', 'area-assessment-panel');
    this.launcher.setAttribute('aria-expanded', 'false');
    this.panel = document.createElement('section');
    this.panel.id = 'area-assessment-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Area insights');
    this.panel.innerHTML = areaPanelMarkup(AREA_COPY);
    const serviceLegend = document.createElement('span');
    serviceLegend.className = 'area-service-legend';
    serviceLegend.textContent = 'Services: ';
    for (const [id, label] of Object.entries(SERVICE_CATEGORIES)) {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.background = serviceColors[id];
      item.append(swatch, document.createTextNode(label));
      serviceLegend.append(item);
    }
    this.panel.querySelector('.area-map-legend').append(serviceLegend);
    this.group = document.createElement('div');
    this.group.id = 'area-assessment-group';
    this.group.append(this.launcher, this.panel);
    document.getElementById('data-toggles').prepend(this.group);
    this.markerTargets = new Map();
    this.markerHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    this.markerHandler.setInputAction((event) => {
      if (this.panel.hidden || this.pickHandler || this.destroyed) return;
      const picked = viewer.scene.pick(event.position);
      const target = this.markerTargets.get(picked?.id);
      if (target) this.analyze(target);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    const metrics = this.panel.querySelector('[data-metrics]');
    this.rows = {};
    for (const [id, meta] of Object.entries(AREA_METRICS)) {
      const row = document.createElement('article');
      row.className = 'area-metric';
      row.style.setProperty('--metric-color', meta.color);
      row.innerHTML = `<div class="area-metric-heading"><label><input type="checkbox" data-select aria-label="Include ${meta.label}"><i></i>${meta.label}</label><div class="area-score"><strong data-score>—</strong><span>Higher is better</span></div></div><div class="area-weight"><label for="area-weight-${id}">Weight</label><input type="range" id="area-weight-${id}" min="0" max="5" step="0.25"><output></output></div><p data-value>Not acquired</p><div class="area-score-track"><i></i></div><details><summary>Details and source</summary><p data-detail></p><a data-source target="_blank" rel="noopener noreferrer" hidden>View source</a></details>`;
      const choice = row.querySelector('[data-select]'),
        weight = row.querySelector('input[type=range]');
      choice.checked = this.selection[id].selected;
      weight.value = this.selection[id].weight;
      if (id === 'housing') {
        const budget = document.createElement('label');
        budget.className = 'area-budget';
        budget.innerHTML =
          'Reference budget <input type="number" min="1" step="100" aria-label="Housing budget"><span></span>';
        row.insertBefore(budget, row.querySelector('details'));
        const budgetHint = document.createElement('p');
        budgetHint.textContent =
          'Budget changes the score, not the source price.';
        row.insertBefore(budgetHint, row.querySelector('details'));
        this.budgetInput = budget.querySelector('input');
        this.budgetUnit = budget.querySelector('span');
        this.listen(this.budgetInput, 'input', () => {
          const unit = this.observations.housing?.unit;
          const value = this.budgetInput.valueAsNumber;
          if (unit && Number.isFinite(value) && value > 0) {
            this.budgets[unit] = value;
            this.persist();
          }
          this.refresh();
        });
      }
      this.listen(choice, 'change', () => {
        this.selection[id].selected = choice.checked;
        if (!choice.checked) {
          this.requests.get(id)?.abort();
          this.requests.delete(id);
        }
        this.persist();
        this.refresh();
        if (
          choice.checked &&
          this.point &&
          (!this.observations[id] || this.observations[id].status === 'loading')
        )
          void this.load(id);
      });
      this.listen(weight, 'input', () => {
        this.selection[id].weight = Number(weight.value);
        this.persist();
        this.refresh();
      });
      metrics.append(row);
      this.rows[id] = row;
    }
    this.listen(this.launcher, 'click', () => this.setOpen(this.panel.hidden));
    this.listen(this.panel.querySelector('[data-close]'), 'click', () =>
      this.setOpen(false),
    );
    this.listen(this.panel.querySelector('[data-analyze]'), 'click', () =>
      this.analyze(this.centerPoint()),
    );
    this.listen(this.panel.querySelector('[data-pick]'), 'click', () =>
      this.startPick(),
    );
    this.listen(
      this.panel.querySelector('[data-search]'),
      'click',
      () => void this.findNearby(),
    );
    this.listen(this.panel.querySelector('[data-use-best]'), 'click', () => {
      if (this.bestArea) this.analyze(this.bestArea.point);
    });
    this.listen(document, 'keydown', (event) => {
      if (event.key === 'Escape' && !this.panel.hidden) this.setOpen(false);
    });
    this.refresh();
  }

  listen(target, type, handler) {
    target.addEventListener(type, handler);
    this.listeners.push(() => target.removeEventListener(type, handler));
  }
  persist() {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ selection: this.selection, budgets: this.budgets }),
      );
    } catch {
      /* Storage may be disabled. */
    }
  }
  setOpen(open) {
    this.panel.hidden = !open;
    this.launcher.setAttribute('aria-expanded', String(open));
    if (!open) {
      this.cancelPick();
      this.launcher.focus();
    } else this.panel.querySelector('[data-analyze]').focus();
    this.renderMap();
  }
  centerPoint() {
    const canvas = this.viewer.scene.canvas;
    return this.pointAt(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
  }
  pointAt(position) {
    const camera = this.viewer.camera,
      scene = this.viewer.scene;
    const ray = camera.getPickRay(position);
    const hit =
      (ray && scene.globe?.pick(ray, scene)) ||
      camera.pickEllipsoid(position, scene.globe?.ellipsoid);
    if (!hit) return null;
    const coordinate = Cesium.Cartographic.fromCartesian(hit);
    return {
      lat: Cesium.Math.toDegrees(coordinate.latitude),
      lon: Cesium.Math.toDegrees(coordinate.longitude),
    };
  }
  startPick() {
    this.cancelPick();
    this.panel.querySelector('[data-place]').textContent =
      'Click a point on the ground. Esc cancels.';
    this.pickHandler = new Cesium.ScreenSpaceEventHandler(
      this.viewer.scene.canvas,
    );
    this.pickHandler.setInputAction((event) => {
      const point = this.pointAt(event.position);
      this.cancelPick();
      this.analyze(point);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    this.viewer.scene.canvas.style.cursor = 'crosshair';
  }
  cancelPick() {
    this.pickHandler?.destroy();
    this.pickHandler = null;
    this.viewer.scene.canvas.style.cursor = '';
  }
  analyze(point) {
    if (!point) {
      this.panel.querySelector('[data-place]').textContent =
        'Point the camera at the ground: the center of this view shows the sky.';
      return;
    }
    this.searchController?.abort();
    this.searchResult = null;
    this.bestArea = null;
    this.panel.querySelector('[data-search-status]').textContent =
      'Compare sampled places around this chosen point. Only complete selected coverage is ranked.';
    if (this.point) {
      const key = `${this.point.lat.toFixed(5)}:${this.point.lon.toFixed(5)}`;
      this.comparedAreas = this.comparedAreas.filter(
        (area) => area.key !== key,
      );
      this.comparedAreas.push({
        key,
        point: { ...this.point },
        observations: { ...this.observations },
      });
      this.comparedAreas = this.comparedAreas.slice(-11);
    }
    const nextKey = `${point.lat.toFixed(5)}:${point.lon.toFixed(5)}`;
    this.comparedAreas = this.comparedAreas.filter(
      (area) => area.key !== nextKey,
    );
    this.revision++;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.point = point;
    this.observations = {};
    this.panel.querySelector('[data-point]').textContent =
      `${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}°`;
    this.panel.querySelector('[data-place]').textContent =
      'Sampled point · each source specifies its actual geographic area.';
    this.refresh();
    for (const id of Object.keys(AREA_METRICS))
      if (this.selection[id].selected) void this.load(id);
  }
  async load(id) {
    this.requests.get(id)?.abort();
    const controller = new AbortController(),
      revision = this.revision;
    this.requests.set(id, controller);
    this.observations[id] = { status: 'loading' };
    this.refresh();
    try {
      const value = await this.source.read(id, this.point, {
        signal: controller.signal,
      });
      if (
        !this.destroyed &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.observations[id] = value;
    } catch (error) {
      if (
        !this.destroyed &&
        !controller.signal.aborted &&
        revision === this.revision
      )
        this.observations[id] = {
          status: 'unavailable',
          reason: error.message,
        };
    } finally {
      if (this.requests.get(id) === controller) this.requests.delete(id);
      if (!this.destroyed && revision === this.revision) this.refresh();
    }
  }
  async findNearby() {
    const status = this.panel.querySelector('[data-search-status]');
    const metrics = Object.keys(AREA_METRICS).filter(
      (id) => this.selection[id].selected && this.selection[id].weight > 0,
    );
    if (!this.point || !metrics.length) {
      status.textContent =
        'Choose a point and at least one parameter with a positive weight.';
      return;
    }
    this.searchController?.abort();
    const controller = new AbortController(),
      revision = this.revision;
    this.searchController = controller;
    this.searchResult = null;
    const button = this.panel.querySelector('[data-search]');
    button.disabled = true;
    status.textContent =
      'Comparing 9 sampled locations with real sources… This can take a few minutes.';
    const origin = { ...this.point };
    try {
      const result = await this.source.read('nearby', origin, {
        signal: controller.signal,
        metrics,
        radius: Number(this.panel.querySelector('[data-search-radius]').value),
      });
      if (
        controller.signal.aborted ||
        this.destroyed ||
        revision !== this.revision
      )
        return;
      if (result.status !== 'available' || !Array.isArray(result.candidates))
        throw new Error(result.reason || 'Nearby search unavailable.');
      this.searchResult = { ...result, origin };
      const originKey = `${origin.lat.toFixed(5)}:${origin.lon.toFixed(5)}`;
      for (const candidate of result.candidates) {
        const key = `${candidate.point.lat.toFixed(5)}:${candidate.point.lon.toFixed(5)}`;
        if (key === originKey) continue;
        this.comparedAreas = this.comparedAreas.filter(
          (area) => area.key !== key,
        );
        this.comparedAreas.push({ ...candidate, key });
      }
      this.comparedAreas = this.comparedAreas.slice(-11);
      this.refresh();
    } catch (error) {
      if (
        !controller.signal.aborted &&
        !this.destroyed &&
        revision === this.revision
      )
        status.textContent = error.message;
    } finally {
      if (this.searchController === controller) {
        this.searchController = null;
        button.disabled = false;
      }
    }
  }
  refresh() {
    const housing = this.observations.housing,
      unit = housing?.unit;
    const editingBudget = document.activeElement === this.budgetInput;
    this.budgetInput.disabled = !unit;
    if (!editingBudget) this.budgetInput.value = unit ? this.budgets[unit] : '';
    this.budgetUnit.textContent = unit || 'Unit shown with the price';
    const budgets = { ...this.budgets };
    if (editingBudget && !(this.budgetInput.valueAsNumber > 0) && unit)
      budgets[unit] = null;
    this.currentBudgets = budgets;
    const index = weightedAreaIndex(this.observations, this.selection, budgets);
    this.panel.querySelector('[data-search]').disabled =
      !!this.searchController || !this.point || this.requests.size > 0;
    this.currentIndex = this.point ? index : { ...index, score: null };
    if (this.searchResult) {
      const ranked = rankNearbyAreas(
        this.searchResult.candidates,
        this.searchResult.origin,
        this.selection,
        budgets,
      );
      this.bestArea = ranked.best;
      this.panel.querySelector('[data-use-best]').hidden = !ranked.best;
      this.panel.querySelector('[data-search-status]').textContent = ranked.best
        ? `Nearest high-scoring sampled match: ${scoreText(ranked.best.index.score)} · ${Math.round(ranked.best.distanceM)} m from your chosen point. Highest sampled score: ${scoreText(ranked.topScore)}; this result is within 2 points. ${ranked.eligible.length}/${this.searchResult.candidates.length} locations have all selected data. ${this.searchResult.warning}`
        : 'No sampled location has all selected parameters available. Inspect missing sources or deselect unavailable parameters; incomplete locations are not ranked.';
    } else if (!this.searchController)
      this.panel.querySelector('[data-use-best]').hidden = true;
    this.panel.querySelector('[data-index]').textContent = scoreText(
      this.currentIndex.score,
    );
    const coverage = `${index.used.length}/${Object.values(this.selection).filter((s) => s.selected && s.weight > 0).length} parameters · ${Math.round(index.coverage * 100)}% of selected weight covered`;
    this.panel.querySelector('[data-coverage]').textContent = !this.point
      ? 'Choose a point to acquire real data.'
      : !index.selectedWeight
        ? 'Select at least one parameter with a positive weight.'
        : `${index.coverage < 1 ? 'Conservative index · missing data contributes 0 · ' : ''}${coverage}${this.requests.size ? ' · acquisition in progress' : ''}`;
    this.panel.querySelector('[data-coverage-bar]').style.width =
      `${index.coverage * 100}%`;
    for (const [id, row] of Object.entries(this.rows)) {
      const choice = this.selection[id],
        observation = this.observations[id];
      const score = areaMetricScore(id, observation, budgets[unit]);
      row.classList.toggle(
        'is-excluded',
        !choice.selected || choice.weight === 0,
      );
      row.querySelector('input[type=range]').disabled = !choice.selected;
      row.querySelector('output').textContent = `×${format(choice.weight)}`;
      row.querySelector('[data-score]').textContent = scoreText(score);
      row.querySelector('.area-score-track i').style.width = `${score ?? 0}%`;
      let value =
        observation?.status === 'loading'
          ? 'Acquiring real data…'
          : observation?.reason || 'Not acquired';
      if (observation?.status === 'available') {
        if (id === 'air')
          value = `US AQI ${format(observation.aqi)} · PM2.5 ${format(observation.pm25)} µg/m³`;
        if (id === 'housing')
          value =
            observation.minimum != null
              ? `${format(observation.minimum)}–${format(observation.maximum)} ${observation.unit} · ${observation.area}`
              : `${format(observation.value)} ${observation.unit} · ${observation.area}`;
        if (id === 'seismic')
          value = `PGA ${observation.pga.toFixed(3)} g · 10% in 50 years`;
        if (id === 'services')
          value =
            (observation.sample ? 'Search sample · ' : '') +
            Object.entries(SERVICE_CATEGORIES)
              .map(
                ([key, label]) =>
                  `${label}: ${observation.nearest[key] ? Math.round(observation.nearest[key].distanceM) + ' m' : 'not mapped'}`,
              )
              .join(' · ');
      }
      if (score == null && observation && observation.status !== 'loading')
        value += ' · Missing data contributes 0 to the index';
      row.querySelector('[data-value]').textContent = value;
      row.querySelector('[data-detail]').textContent =
        observation?.status === 'available'
          ? [
              observation.source,
              `Reference: ${observation.date || 'date not supplied'}`,
              observation.release,
              observation.resolution,
              observation.count ? `${observation.count} sales` : '',
              observation.marginOfError != null
                ? `Margin of error: ±${format(observation.marginOfError)} ${observation.unit}`
                : '',
              observation.warning,
              observation.licence,
              observation.fetchedAt
                ? `Retrieved: ${new Date(observation.fetchedAt).toLocaleString('en-GB')}`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : observation?.reason || 'Sources appear after acquisition.';
      const link = row.querySelector('[data-source]');
      link.hidden = !observation?.sourceUrl;
      if (observation?.sourceUrl?.startsWith('https://'))
        link.href = observation.sourceUrl;
      else link.removeAttribute('href');
    }
    this.renderMap();
  }
  renderMap() {
    for (const entity of this.entities) this.viewer.entities.remove(entity);
    this.entities = [];
    this.markerTargets.clear();
    if (!this.point || this.panel.hidden || this.destroyed) {
      clearOverlaySource('area-assessment');
      this.viewer.scene.requestRender();
      return;
    }
    const add = (definition, target) => {
      const entity = this.viewer.entities.add(definition);
      this.entities.push(entity);
      if (target) this.markerTargets.set(entity, { ...target });
    };
    const position = Cesium.Cartesian3.fromDegrees(
      this.point.lon,
      this.point.lat,
    );
    const resultColor = areaScoreColor(this.currentIndex.score);
    const selected = Object.keys(AREA_METRICS).filter(
      (id) => this.selection[id].selected,
    );
    const comparisonEntries = this.comparedAreas.map((area) => {
      const index = weightedAreaIndex(
        area.observations,
        this.selection,
        this.currentBudgets,
      );
      const position = Cesium.Cartesian3.fromDegrees(
        area.point.lon,
        area.point.lat,
      );
      const color = areaScoreColor(index.score);
      const bestKey = this.bestArea
        ? `${this.bestArea.point.lat.toFixed(5)}:${this.bestArea.point.lon.toFixed(5)}`
        : null;
      const isBest = area.key === bestKey;
      add(
        {
          name: `Analyzed area · ${scoreText(index.score)} · ${Math.round(index.coverage * 100)}% coverage`,
          position,
          point: {
            pixelSize: isBest ? 18 : 12,
            color: Cesium.Color.fromCssColorString(color),
            outlineColor: isBest ? Cesium.Color.WHITE : Cesium.Color.BLACK,
            outlineWidth: isBest ? 3 : 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        },
        area.point,
      );
      return {
        id: area.key,
        accessibilityLabel: `Analyze area at ${area.point.lat.toFixed(4)}, ${area.point.lon.toFixed(4)} · ${scoreText(index.score)}`,
        activate: () => this.analyze(area.point),
        position,
        variant: isBest ? 'card' : 'label',
        pinned: isBest,
        title: `${isBest ? 'BEST NEARBY' : 'AREA'} ${scoreText(index.score)}`,
        details: isBest
          ? [
              `${Math.round(index.coverage * 100)}% of selected weight covered`,
              ...index.used.map(
                (row) =>
                  `${AREA_METRICS[row.id].label}: ${scoreText(row.score)}`,
              ),
            ]
          : [],
        accent: color,
        gapPx: 16,
        edgeFade: 'none',
      };
    });
    setOverlayEntries(
      'area-assessment',
      selected.length
        ? [
            ...comparisonEntries,
            {
              id: 'sample',
              position,
              variant: 'card',
              pinned: true,
              title: `INDEX ${scoreText(this.currentIndex.score)}`,
              details: selected.map(
                (id) =>
                  `${AREA_METRICS[id].label}: ${scoreText(this.currentIndex.used.find((row) => row.id === id)?.score)}`,
              ),
              accent: resultColor,
              gapPx: 16,
              edgeFade: 'none',
            },
          ]
        : [],
    );
    if (selected.length)
      add(
        {
          name: 'Sampled point · area insights',
          position,
          point: {
            pixelSize: 10,
            color: Cesium.Color.fromCssColorString(resultColor),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        },
        this.point,
      );
    if (
      this.selection.services.selected &&
      this.observations.services?.status === 'available'
    ) {
      add({
        name: 'Service search area · 3 km',
        position,
        ellipse: {
          semiMajorAxis: 3000,
          semiMinorAxis: 3000,
          material: Cesium.Color.fromCssColorString('#7faaff').withAlpha(0.07),
          outline: true,
          outlineColor:
            Cesium.Color.fromCssColorString('#7faaff').withAlpha(0.7),
        },
      });
      for (const poi of this.observations.services.pois || [])
        add(
          {
            name: `${SERVICE_CATEGORIES[poi.category]}: ${poi.name} · ${Math.round(poi.distanceM)} m`,
            position: Cesium.Cartesian3.fromDegrees(poi.lon, poi.lat),
            point: {
              pixelSize: 7,
              color: Cesium.Color.fromCssColorString(
                serviceColors[poi.category] || '#38bdf8',
              ),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          },
          { lat: poi.lat, lon: poi.lon },
        );
    }
    this.viewer.scene.requestRender();
  }
  destroy() {
    clearOverlaySource('area-assessment');
    this.searchController?.abort();
    this.destroyed = true;
    this.revision++;
    this.cancelPick();
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    for (const remove of this.listeners) remove();
    for (const entity of this.entities) this.viewer.entities.remove(entity);
    this.markerHandler.destroy();
    this.markerTargets.clear();
    this.group.remove();
    this.viewer.scene.requestRender();
  }
}
