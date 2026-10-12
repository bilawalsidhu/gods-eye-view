import * as Cesium from 'cesium';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import { calculateSun, wallTime, shadowEndpoint } from '../analysis/solar.js';
import { boundedArea, newsRequest } from '../analysis/areaNews.js';

/** Opt-in local sun sketches and explicitly requested news; owns all temporary resources. */
export class SunNewsTools {
  constructor({
    button,
    viewer,
    closeMenu = () => {},
    requestRender = () => {},
  }) {
    Object.assign(this, { button, viewer, closeMenu, requestRender });
    this.listeners = new AbortController();
    this.generation = 0;
    if (!button || !viewer) return;
    this.source = new Cesium.CustomDataSource('sun-news-tools');
    this.added = viewer.dataSources.add(this.source);
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'sun-news-tools';
    this.dialog.setAttribute('aria-labelledby', 'sun-news-title');
    this.dialog.innerHTML = `<header><h2 id="sun-news-title">Sun & area news</h2><button type="button" data-tool="close">BACK TO MAP</button></header>
      <section><h3>Sun, time & approximate shadow</h3><div class="analysis-row"><button type="button" data-tool="pick-sun">PICK SUN POINT</button><label>Latitude<input data-field="lat" type="number" step="any" min="-89.9" max="89.9"></label><label>Longitude<input data-field="lon" type="number" step="any" min="-180" max="180"></label></div>
      <div class="analysis-row"><label>Date & clock time<input data-field="instant" type="datetime-local" min="1900-01-01T00:00" max="2100-12-31T23:59"></label><label>Time zone (IANA)<input data-field="zone" type="text" maxlength="80" placeholder="America/New_York"></label></div>
      <label>Time of day<input data-field="minute" type="range" min="0" max="1439" step="15" aria-label="Selected clock time"></label>
      <div class="analysis-row"><label>Vertical object height (m)<input data-field="height" type="number" min="0" max="200" step="0.1" value="2"></label><button type="button" data-tool="sun-now">USE NOW</button><button type="button" data-tool="sun">CALCULATE & SKETCH</button></div>
      <p>Calculated locally. Sketch assumes level, unobstructed ground and a vertical object; it ignores terrain, buildings and changing atmospheric conditions. It does not change globe lighting.</p><p data-sun-status role="status" aria-live="polite">Pick a point and choose its date, time and time zone.</p><dl data-sun-result></dl><p class="analysis-credit"><a href="https://github.com/mourner/suncalc" target="_blank" rel="noopener noreferrer">SunCalc</a> · <a href="/licenses/suncalc.txt" target="_blank" rel="noopener noreferrer">BSD license</a></p></section>
      <section><h3>News text search (limited geography)</h3><div class="analysis-row"><button type="button" data-tool="pick-area">PICK TWO AREA CORNERS</button><button type="button" data-tool="view-area">USE CURRENT VIEW</button></div><p data-area-status role="status">No bounded area selected.</p><label>City/region name in this area<input data-field="place" type="text" maxlength="80" placeholder="City or region name"></label><label>Optional topic<input data-field="topic" type="text" maxlength="100" placeholder="Plain-text topic"></label>
      <div class="analysis-row"><label>From (UTC day)<input data-field="start" type="date"></label><label>Through (UTC day)<input data-field="end" type="date"></label></div><p>GDELT matches place names in article text. This is not verified spatial filtering: the rectangle provides area-of-interest context only. Geographic news retrieval is unavailable; no news pins are drawn. Only search text and dates go to GDELT.</p>
      <div class="analysis-row"><button type="button" data-tool="news">SEARCH NEWS</button><button type="button" data-tool="cancel-news" disabled>CANCEL SEARCH</button><button type="button" data-tool="clear-news">CLEAR NEWS</button></div><p data-news-status role="status" aria-live="polite">Search runs only when clicked. Up to 25 source-linked articles; up to 31 days within the last89 days.</p><p data-news-stale hidden>STALE: these cards belong to an earlier search. Their source/date labels remain below.</p><ol data-news-results></ol><p class="analysis-credit"><a href="https://www.gdeltproject.org/" target="_blank" rel="noopener noreferrer">GDELT</a></p></section><footer><button type="button" data-tool="clear-sketches">CLEAR MAP SKETCHES</button></footer>`;
    document.body.append(this.dialog);
    this.pickBar = document.createElement('div');
    this.pickBar.id = 'analysis-pick-bar';
    this.pickBar.hidden = true;
    this.pickBar.innerHTML =
      '<span role="status"></span><button type="button">CANCEL PICK</button>';
    document.body.append(this.pickBar);
    this.listen(button, 'click', () => this.open());
    this.listen(this.dialog, 'click', (e) => {
      const a = e.target.closest('[data-tool]')?.dataset.tool;
      if (a) void this.action(a);
    });
    this.listen(this.dialog, 'cancel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.listen(this.dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.listen(this.dialog, 'input', (e) => {
      const field = e.target.dataset.field;
      if (field === 'minute') {
        const v = this.field('instant').value;
        if (v) {
          const minute = Number(this.field('minute').value);
          this.field('instant').value =
            `${v.slice(0, 10)}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        }
        this.computeSun();
      } else if (['lat', 'lon', 'instant', 'zone', 'height'].includes(field)) {
        if (field === 'instant') this.syncMinute();
        this.clearGroup('sun');
        this.sunStatus('Inputs changed. Calculate again.');
      }
      if (['place', 'topic', 'start', 'end'].includes(field))
        this.markStale(
          'Search inputs changed. Click Search news for fresh results.',
        );
    });
    this.listen(this.pickBar.querySelector('button'), 'click', () => {
      this.cancelPick();
      this.open();
    });
    this.listen(
      document,
      'keydown',
      (e) => {
        if (this.picking && e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.cancelPick();
          this.open();
        }
      },
      true,
    );
    this.field('zone').value =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.useNow();
    const now = new Date();
    this.field('end').value = now.toISOString().slice(0, 10);
    this.field('start').value = new Date(now.valueOf() - 6 * 86400000)
      .toISOString()
      .slice(0, 10);
  }
  listen(node, type, fn, options = {}) {
    node?.addEventListener(type, fn, {
      ...(typeof options === 'object' ? options : { capture: options }),
      signal: this.listeners.signal,
    });
  }
  field(name) {
    return this.dialog.querySelector(`[data-field="${name}"]`);
  }
  sunStatus(text) {
    this.dialog.querySelector('[data-sun-status]').textContent = text;
  }
  newsStatus(text) {
    this.dialog.querySelector('[data-news-status]').textContent = text;
  }
  open() {
    if (!this.dialog || this.destroyed) return;
    this.closeMenu();
    if (!this.dialog.open) this.dialog.showModal();
    this.button.setAttribute('aria-expanded', 'true');
  }
  close() {
    this.cancelPick();
    this.cancelNews();
    this.dialog?.close();
    this.button?.setAttribute('aria-expanded', 'false');
    (this.button?.getClientRects().length
      ? this.button
      : document.getElementById('mobile-menu-open')
    )?.focus({ preventScroll: true });
  }
  useNow() {
    try {
      this.field('instant').value = wallTime(
        new Date(),
        this.field('zone').value.trim(),
      );
      this.syncMinute();
    } catch {
      this.sunStatus('Enter a valid IANA time zone, such as UTC.');
    }
  }
  syncMinute() {
    const clock = /T(\d{2}):(\d{2})/.exec(this.field('instant').value);
    if (clock)
      this.field('minute').value = Number(clock[1]) * 60 + Number(clock[2]);
  }
  setSunPoint(point) {
    this.field('lat').value = point.lat.toFixed(6);
    this.field('lon').value = point.lon.toFixed(6);
    this.clearGroup('sun');
    this.sunStatus('Point selected. Calculate to draw the approximate shadow.');
  }
  clearGroup(group) {
    if (!this.source) return;
    for (const entity of [...this.source.entities.values])
      if (entity.analysisGroup === group) this.source.entities.remove(entity);
    this.requestRender('analysis-sketch');
  }
  entity(group, options) {
    const e = this.source.entities.add(options);
    e.analysisGroup = group;
    return e;
  }
  setArea(area) {
    this.area = boundedArea(area);
    this.markStale('Area changed. Search again.');
    this.clearGroup('area');
    this.entity('area', {
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(
          this.area.west,
          this.area.south,
          this.area.east,
          this.area.north,
        ),
        material: Cesium.Color.CYAN.withAlpha(0.08),
        outline: true,
        outlineColor: Cesium.Color.CYAN,
      },
      name: 'Selected news area; event locations unverified',
    });
    this.dialog.querySelector('[data-area-status]').textContent =
      `Selected rectangle: ${this.area.south.toFixed(3)},${this.area.west.toFixed(3)} to ${this.area.north.toFixed(3)},${this.area.east.toFixed(3)}. Area of interest only; articles are not spatially verified.`;
  }
  pick(kind) {
    this.cancelPick();
    this.lease = claimPointer('sun-news-tools');
    if (!this.lease) {
      this.newsStatus(
        'Another map tool is using the pointer. Finish it first.',
      );
      return;
    }
    this.picking = { kind, points: [] };
    this.dialog.close();
    this.closeMenu();
    this.pickBar.hidden = false;
    this.pickBar.querySelector('span').textContent =
      kind === 'sun'
        ? 'Click a sun calculation point.'
        : 'Click the first area corner.';
    this.pickHandler = new Cesium.ScreenSpaceEventHandler(
      this.viewer.scene.canvas,
    );
    this.pickHandler.setInputAction((e) => {
      const position = this.viewer.camera.pickEllipsoid(
        e.position,
        this.viewer.scene.globe.ellipsoid,
      );
      if (!position) return;
      const c = Cesium.Cartographic.fromCartesian(position),
        p = {
          lat: Cesium.Math.toDegrees(c.latitude),
          lon: Cesium.Math.toDegrees(c.longitude),
        };
      if (kind === 'sun') {
        this.setSunPoint(p);
        this.cancelPick();
        this.open();
        return;
      }
      this.picking.points.push(p);
      if (this.picking.points.length === 1) {
        this.pickBar.querySelector('span').textContent =
          'Click the opposite area corner.';
        return;
      }
      const [a, b] = this.picking.points;
      try {
        this.setArea({
          west: Math.min(a.lon, b.lon),
          east: Math.max(a.lon, b.lon),
          south: Math.min(a.lat, b.lat),
          north: Math.max(a.lat, b.lat),
        });
      } catch (error) {
        this.newsStatus(error.message);
      }
      this.cancelPick();
      this.open();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  cancelPick() {
    this.pickHandler?.destroy();
    this.pickHandler = null;
    releasePointer(this.lease);
    this.lease = null;
    this.picking = null;
    if (this.pickBar) this.pickBar.hidden = true;
  }
  computeSun() {
    this.clearGroup('sun');
    const list = this.dialog.querySelector('[data-sun-result]');
    list.replaceChildren();
    try {
      if (!this.field('lat').value.trim() || !this.field('lon').value.trim())
        throw Error('Pick a point or enter its latitude and longitude.');
      const lat = Number(this.field('lat').value),
        lon = Number(this.field('lon').value),
        zone = this.field('zone').value.trim();
      const result = calculateSun({
        lat,
        lon,
        value: this.field('instant').value,
        timeZone: zone,
        heightM: Number(this.field('height').value),
      });
      this.syncMinute();
      const show = (iso) =>
        iso
          ? new Date(iso).toLocaleString(undefined, {
              timeZone: zone,
              timeZoneName: 'short',
            })
          : 'No rise/set on this day';
      for (const [label, value] of [
        ['Sun bearing (north=0°)', `${result.azimuthDeg.toFixed(1)}°`],
        ['Sun elevation', `${result.altitudeDeg.toFixed(1)}°`],
        ['Sunrise', show(result.sunrise)],
        ['Sunset', show(result.sunset)],
        [
          'Shadow estimate',
          result.shadowLengthM === null
            ? 'None below or very near the horizon'
            : `${result.shadowLengthM.toFixed(1)} m toward ${result.shadowBearingDeg.toFixed(1)}°`,
        ],
        ['Chosen instant', `${result.instant} · ${zone}`],
      ]) {
        const dt = document.createElement('dt'),
          dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        list.append(dt, dd);
      }
      this.entity('sun', {
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 10,
          color: Cesium.Color.YELLOW,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        name: 'Local sun calculation point',
      });
      if (result.shadowLengthM !== null && result.shadowLengthM > 0) {
        const end = shadowEndpoint(
          lat,
          lon,
          result.shadowBearingDeg,
          result.shadowLengthM,
        );
        this.entity('sun', {
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([
              lon,
              lat,
              end.lon,
              end.lat,
            ]),
            width: 3,
            clampToGround: true,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.YELLOW,
            }),
          },
          name: 'Approximate level-ground shadow sketch',
        });
      }
      this.sunStatus(
        result.ambiguous
          ? 'Repeated daylight-saving clock time: earlier occurrence chosen. Check the displayed UTC instant.'
          : 'Calculated locally. Dashed line is a level-ground estimate, not a measured shadow.',
      );
      this.lastSun = result;
      this.requestRender('sun-sketch');
    } catch (error) {
      this.sunStatus(error.message);
      this.lastSun = null;
    }
  }
  markStale(message) {
    this.cancelNews();
    this.clearGroup('news');
    if (this.lastNews)
      this.dialog.querySelector('[data-news-stale]').hidden = false;
    this.newsStatus(message);
  }
  cancelNews() {
    this.generation++;
    this.request?.abort();
    this.request = null;
    if (this.dialog) {
      this.dialog.querySelector('[data-tool="cancel-news"]').disabled = true;
      this.dialog.querySelector('[data-tool="news"]').disabled = false;
    }
  }
  renderNews(result) {
    const list = this.dialog.querySelector('[data-news-results]');
    list.replaceChildren();
    for (const row of result.articles) {
      const li = document.createElement('li'),
        a = document.createElement('a'),
        meta = document.createElement('p');
      a.textContent = row.title;
      a.href = row.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.referrerPolicy = 'no-referrer';
      meta.textContent = `${row.publisher} · GDELT seen${row.seenAt} · Place-name match, location unverified`;
      li.append(a, meta);
      list.append(li);
    }
    this.dialog.querySelector('[data-news-stale]').hidden = false;
  }
  async searchNews() {
    if (Date.now() < (this.retryUntil || 0)) {
      this.newsStatus(
        `Provider rate limit: wait ${Math.ceil((this.retryUntil - Date.now()) / 1000)} seconds before another search.`,
      );
      return;
    }
    this.cancelNews();
    const generation = this.generation,
      abort = new AbortController();
    this.request = abort;
    this.clearGroup('news');
    if (this.lastNews)
      this.dialog.querySelector('[data-news-stale]').hidden = false;
    this.dialog.querySelector('[data-tool="news"]').disabled = true;
    this.dialog.querySelector('[data-tool="cancel-news"]').disabled = false;
    try {
      const endDay = this.field('end').value;
      const input = newsRequest({
        area: this.area,
        place: this.field('place').value,
        topic: this.field('topic').value,
        start: this.field('start').value + 'T00:00:00Z',
        end: new Date(
          Math.min(Date.now(), Date.parse(endDay + 'T23:59:59Z')),
        ).toISOString(),
      });
      this.newsStatus('Searching GDELT. Previous cards, if any, are stale.');
      const response = await fetch('/api/area-news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: abort.signal,
      });
      const result = await response.json();
      if (response.status === 429)
        this.retryUntil =
          Date.now() + Math.max(6, result.retryAfterSeconds || 60) * 1000;
      if (!response.ok)
        throw Error(result.error || 'News provider unavailable.');
      if (generation !== this.generation || this.destroyed) return;
      this.lastNews = result;
      this.renderNews(result);
      this.dialog.querySelector('[data-news-stale]').hidden = true;
      this.newsStatus(
        `${result.articles.length} place-name matches${result.limited ? ' (bounded result limit)' : ''}. Queried ${result.queriedAt}. Dates are GDELT seen/indexed times. Event locations are unverified.`,
      );
      // No substitute place-center pins: no source-derived article coordinates.
    } catch (error) {
      if (generation === this.generation && !this.destroyed)
        this.newsStatus(
          abort.signal.aborted
            ? 'Search canceled. Earlier cards are stale.'
            : `${error.message} No fresh results. Earlier cards, if any, remain stale.`,
        );
    } finally {
      if (this.request === abort) {
        this.request = null;
        this.dialog.querySelector('[data-tool="news"]').disabled = false;
        this.dialog.querySelector('[data-tool="cancel-news"]').disabled = true;
      }
    }
  }
  async action(a) {
    if (a === 'close') this.close();
    if (a === 'pick-sun') this.pick('sun');
    if (a === 'pick-area') this.pick('area');
    if (a === 'sun') this.computeSun();
    if (a === 'sun-now') {
      this.useNow();
      this.computeSun();
    }
    if (a === 'news') await this.searchNews();
    if (a === 'cancel-news') {
      this.cancelNews();
      this.newsStatus('Search canceled. Earlier cards remain stale.');
    }
    if (a === 'clear-news') {
      this.cancelNews();
      this.lastNews = null;
      this.dialog.querySelector('[data-news-results]').replaceChildren();
      this.dialog.querySelector('[data-news-stale]').hidden = true;
      this.clearGroup('news');
      this.newsStatus('News cleared.');
    }
    if (a === 'clear-sketches') {
      this.source.entities.removeAll();
      this.requestRender('analysis-clear');
    }
    if (a === 'view-area') {
      try {
        const r = this.viewer.camera.computeViewRectangle(
          this.viewer.scene.globe.ellipsoid,
        );
        if (!r)
          throw Error(
            'The current camera does not show a bounded ground area.',
          );
        this.setArea({
          west: Cesium.Math.toDegrees(r.west),
          south: Cesium.Math.toDegrees(r.south),
          east: Cesium.Math.toDegrees(r.east),
          north: Cesium.Math.toDegrees(r.north),
        });
      } catch (e) {
        this.newsStatus(e.message + ' Zoom closer or pick two corners.');
      }
    }
  }
  destroy() {
    this.destroyed = true;
    this.cancelPick();
    this.cancelNews();
    this.listeners.abort();
    this.dialog?.remove();
    this.pickBar?.remove();
    if (this.source) {
      this.viewer.dataSources.remove(this.source, true);
      this.added?.then(() => {
        if (this.viewer && !this.viewer.isDestroyed())
          this.viewer.dataSources.remove(this.source, true);
      });
    }
  }
}
