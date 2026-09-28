/** Regional briefing requests, pages and rotation for the Cockpit controller. */
import {
  COCKPIT_BRIEF_ROTATE_MS,
  COCKPIT_BRIEF_CYCLE_OFF_HELP,
  COCKPIT_BRIEF_CYCLE_ON_HELP,
  COCKPIT_REGIONAL_REFRESH_MS,
  COCKPIT_REGIONAL_REFRESH_DISTANCE_M,
  COCKPIT_BRIEF_PAGES,
  formatCockpitBriefAge,
  formatCockpitWindDirection,
} from './cockpitPresentation.js';

export function showBriefPage(index, { manual = false } = {}) {
  if (this.destroyed) return;
  const count = COCKPIT_BRIEF_PAGES.length;
  this.briefPageIndex = ((Number(index) % count) + count) % count;
  const page = COCKPIT_BRIEF_PAGES[this.briefPageIndex];
  this.briefPages.forEach((element) => {
    element.hidden = element.dataset.cockpitBriefPage !== page.id;
  });
  this.briefTabs.forEach((button) => {
    const current =
      Number(button.dataset.cockpitBriefIndex) === this.briefPageIndex;
    button.setAttribute('aria-current', current ? 'true' : 'false');
  });
  if (this.briefKicker) {
    const indicator = this.briefKicker.querySelector('i');
    this.briefKicker.replaceChildren(
      ...[indicator, document.createTextNode(` ${page.kicker}`)].filter(
        Boolean,
      ),
    );
  }
  if (this.briefSubtitle) this.briefSubtitle.textContent = page.subtitle;
  if (this.briefPosition)
    this.briefPosition.textContent = `${this.briefPageIndex + 1} / ${count}`;
  if (this.briefSource) this.briefSource.textContent = page.source;
  if (this.signalStream) this.signalStream.dataset.briefPage = page.id;
  if (manual && this.briefAutoRotateEnabled)
    this.startBriefRotation({ reset: true });
  if (page.id === 'news') this.selectNewsCategory(this.newsCategory);
  this.scheduleContextLayout();
}

function renderNewsArticles(list, articles) {
  if (!list) return;
  list.replaceChildren(
    ...articles.slice(0, 8).map((article) => {
      const entry = document.createElement('li');
      const link = document.createElement('a');
      link.href = article.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const title = document.createElement('strong');
      title.textContent = article.title;
      const metadata = document.createElement('span');
      metadata.textContent = `${article.source || article.domain || 'SOURCE'} · ${formatCockpitBriefAge(article.publishedAt)}`;
      link.append(title, metadata);
      entry.append(link);
      return entry;
    }),
  );
}

function renderNewsStatus(controller, state, message) {
  if (!controller.newsStatus) return;
  controller.newsStatus.hidden = false;
  controller.newsStatus.dataset.state = state;
  controller.newsStatus.textContent = message;
}

export function selectNewsCategory(category) {
  if (
    !['world', 'politics', 'economy', 'crises', 'regional'].includes(category)
  )
    return;
  this.newsCategory = category;
  this.newsCategoryTabs?.forEach((button) => {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.newsCategory === category),
    );
  });
  this.newsAbort?.abort();
  this.newsAbort = null;
  this.newsRequestToken += 1;
  this.newsList?.replaceChildren();

  if (category === 'regional') {
    const regional = this.regionalBrief;
    if (!regional) {
      if (this.active && this.lastAircraftInfo) {
        renderNewsStatus(this, 'loading', 'ACQUIRING REGIONAL HEADLINES');
        this.maybeRefreshRegionalBrief(this.lastAircraftInfo);
      } else {
        renderNewsStatus(this, 'unavailable', 'REGIONAL NEWS UNAVAILABLE');
      }
      return;
    }
    const articles = Array.isArray(regional.articles) ? regional.articles : [];
    renderNewsArticles(this.newsList, articles);
    if (articles.length) {
      if (this.newsStatus) this.newsStatus.hidden = true;
      if (this.briefSource)
        this.briefSource.textContent = `${String(regional.newsSource || 'REGIONAL NEWS').toUpperCase()} · LOCATION QUERY`;
    } else {
      renderNewsStatus(
        this,
        regional.newsStatus === 'empty' ? 'empty' : 'unavailable',
        regional.newsStatus === 'empty'
          ? 'NO RECENT LOCATION MATCHES'
          : 'REGIONAL NEWS UNAVAILABLE',
      );
    }
    return;
  }

  const cached = this.newsResults.get(category);
  const cachedAt = this.newsFetchedAt.get(category) || 0;
  if (cached && Date.now() - cachedAt < 5 * 60_000) {
    this.renderNewsResponse(cached);
    return;
  }
  if (!this.active || this.destroyed) return;
  const controller = new AbortController();
  const requestToken = ++this.newsRequestToken;
  this.newsAbort = controller;
  renderNewsStatus(
    this,
    'loading',
    `LOADING ${category.toUpperCase()} HEADLINES`,
  );
  Promise.resolve()
    .then(() =>
      this.services.fetchNewsHeadlines(category, {
        signal: controller.signal,
      }),
    )
    .then((payload) => {
      if (
        !this.active ||
        requestToken !== this.newsRequestToken ||
        category !== this.newsCategory
      )
        return;
      this.newsResults.set(category, payload);
      this.newsFetchedAt.set(category, Date.now());
      this.renderNewsResponse(payload);
    })
    .catch((error) => {
      if (
        error?.name === 'AbortError' ||
        requestToken !== this.newsRequestToken ||
        category !== this.newsCategory
      )
        return;
      const messages = {
        missing_api_key: 'NEWSAPI_API_KEY REQUIRED · ADD IN PROVIDER SETTINGS',
        rate_limited: `NEWSAPI RATE LIMIT · RETRY IN ${Math.ceil((error.retryAfterMs || 60_000) / 1000)}S`,
        upstream_error: 'NEWSAPI TEMPORARILY UNAVAILABLE',
      };
      renderNewsStatus(
        this,
        error.code === 'rate_limited' ? 'rate_limited' : 'unavailable',
        messages[error.code] || 'NEWS SERVICE UNAVAILABLE',
      );
    })
    .finally(() => {
      if (this.newsAbort === controller) this.newsAbort = null;
    });
}

export function renderNewsResponse(payload) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  renderNewsArticles(this.newsList, articles);
  if (articles.length) {
    if (this.newsStatus) this.newsStatus.hidden = true;
    if (this.briefSource)
      this.briefSource.textContent = `NEWSAPI · WORLDWIDE · DUTCH · ${this.newsCategory.toUpperCase()}`;
  } else {
    renderNewsStatus(this, 'empty', 'NO RECENT HEADLINES IN THIS CATEGORY');
  }
  this.scheduleContextLayout();
}

export function setBriefAutoRotate(enabled) {
  if (this.destroyed) return;
  this.briefAutoRotateEnabled = Boolean(enabled);
  if (this.briefAutoToggle) {
    this.briefAutoToggle.setAttribute(
      'aria-pressed',
      String(this.briefAutoRotateEnabled),
    );
    const label = this.briefAutoRotateEnabled ? 'CYCLE ON' : 'CYCLE OFF';
    this.briefAutoToggle.textContent = label;
    const help = this.briefAutoRotateEnabled
      ? COCKPIT_BRIEF_CYCLE_ON_HELP
      : COCKPIT_BRIEF_CYCLE_OFF_HELP;
    this.briefAutoToggle.setAttribute('aria-label', label);
    this.briefAutoToggle.title = help;
  }
  if (this.briefAutoRotateEnabled) this.startBriefRotation({ reset: true });
  else this.stopBriefRotation();
}

export function startBriefRotation({ reset = false } = {}) {
  if (this.destroyed) return;
  if (reset) this.stopBriefRotation();
  if (
    !this.briefAutoRotateEnabled ||
    this.briefTimer ||
    !this.active ||
    this.signalCollapsed ||
    document.hidden
  )
    return;
  this.briefTimer = window.setTimeout(() => {
    this.briefTimer = null;
    if (this.destroyed) return;
    const hasPointer = this.signalStream?.matches(':hover') === true;
    const hasFocus =
      this.signalStream?.contains(document.activeElement) === true;
    const isInteracting = hasPointer || hasFocus;
    if (!isInteracting) {
      this.showBriefPage(this.briefPageIndex + 1);
    }
    this.startBriefRotation();
  }, COCKPIT_BRIEF_ROTATE_MS);
}

export function stopBriefRotation() {
  if (this.briefTimer) window.clearTimeout(this.briefTimer);
  this.briefTimer = null;
}

export function updateLocalPosition(info) {
  if (!this.localCoordinates) return;
  if (!Number.isFinite(info.latitude) || !Number.isFinite(info.longitude)) {
    this.localCoordinates.textContent = 'POSITION UNAVAILABLE';
    return;
  }
  const lat = `${Math.abs(info.latitude).toFixed(3)}°${info.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(info.longitude).toFixed(3)}°${info.longitude >= 0 ? 'E' : 'W'}`;
  this.localCoordinates.textContent = `${lat} · ${lon}`;
}

export function maybeRefreshRegionalBrief(info) {
  if (this.destroyed) return;
  if (
    !this.active ||
    !Number.isFinite(info.latitude) ||
    !Number.isFinite(info.longitude)
  )
    return;
  const subjectId = `${info.layerId || 'aircraft'}:${info.icao24 || info.registration || info.callsign || 'unknown'}`;
  if (subjectId !== this.regionalBriefSubjectId) {
    this.regionalBriefAbort?.abort();
    this.regionalBriefAbort = null;
    this.regionalBriefRequestToken += 1;
    this.regionalBriefSubjectId = subjectId;
    this.regionalBrief = null;
    this.regionalBriefAnchor = null;
    this.regionalBriefFetchedAt = 0;
  }
  const point = { latitude: info.latitude, longitude: info.longitude };
  const ageMs = Date.now() - this.regionalBriefFetchedAt;
  const distanceM = this.services.regionalDistanceM(
    this.regionalBriefAnchor,
    point,
  );
  if (
    this.regionalBriefAbort ||
    (ageMs < COCKPIT_REGIONAL_REFRESH_MS &&
      distanceM < COCKPIT_REGIONAL_REFRESH_DISTANCE_M)
  )
    return;

  this.regionalBriefAnchor = point;
  this.regionalBriefFetchedAt = Date.now();
  const controller = new AbortController();
  const requestToken = ++this.regionalBriefRequestToken;
  this.regionalBriefAbort = controller;
  if (!this.regionalBrief) this.renderRegionalBriefStatus('loading', info);
  this.services
    .fetchRegionalBrief(point.latitude, point.longitude, {
      signal: controller.signal,
    })
    .then((payload) => {
      if (
        !this.active ||
        requestToken !== this.regionalBriefRequestToken ||
        subjectId !== this.regionalBriefSubjectId
      )
        return;
      this.regionalBrief = payload;
      this.renderRegionalBrief(payload, info);
    })
    .catch((error) => {
      if (
        error?.name !== 'AbortError' &&
        this.active &&
        requestToken === this.regionalBriefRequestToken &&
        subjectId === this.regionalBriefSubjectId
      ) {
        this.renderRegionalBriefStatus('unavailable', info);
      }
    })
    .finally(() => {
      if (this.regionalBriefAbort === controller)
        this.regionalBriefAbort = null;
    });
}

export function renderRegionalBriefStatus(status, info) {
  if (this.newsCategory === 'regional') {
    renderNewsStatus(
      this,
      status,
      status === 'loading'
        ? 'ACQUIRING REGIONAL HEADLINES'
        : 'REGIONAL NEWS UNAVAILABLE',
    );
    if (status === 'unavailable') this.newsList?.replaceChildren();
  }
  if (this.localPlace && status === 'loading')
    this.localPlace.textContent = 'RESOLVING REGION';
  if (this.localPlace && status === 'unavailable')
    this.localPlace.textContent = 'REGION UNAVAILABLE';
  this.updateLocalPosition(info);
}

export function renderRegionalBrief(payload, info) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  if (this.newsCategory === 'regional') {
    renderNewsArticles(this.newsList, articles);
    if (articles.length) {
      if (this.newsStatus) this.newsStatus.hidden = true;
    } else {
      renderNewsStatus(
        this,
        payload?.newsStatus === 'empty' ? 'empty' : 'unavailable',
        payload?.newsStatus === 'empty'
          ? 'NO RECENT LOCATION MATCHES'
          : 'REGIONAL NEWS UNAVAILABLE',
      );
    }
  }

  const placeLabel =
    payload?.place?.label || payload?.place?.country || 'REGION UNAVAILABLE';
  if (this.localPlace) this.localPlace.textContent = placeLabel.toUpperCase();
  this.updateLocalPosition(info);
  const weather = payload?.weather;
  if (this.localTemperature) {
    this.localTemperature.textContent = Number.isFinite(weather?.temperatureC)
      ? `${Math.round(weather.temperatureC)}°C`
      : '—';
  }
  if (this.localWind) {
    this.localWind.textContent = Number.isFinite(weather?.windKph)
      ? `${Math.round(weather.windKph)} KM/H`
      : '—';
  }
  if (this.localWindDirection) {
    this.localWindDirection.textContent = formatCockpitWindDirection(
      weather?.windDirectionDeg,
    );
  }
  if (this.localCondition)
    this.localCondition.textContent = this.services.weatherCodeLabel(
      weather?.weatherCode,
    );
  if (this.localCloud) {
    this.localCloud.textContent = Number.isFinite(weather?.cloudCoverPct)
      ? `CLOUD ${Math.round(weather.cloudCoverPct)}%`
      : 'CLOUD UNKNOWN';
  }
  if (this.localPrecipitation) {
    this.localPrecipitation.textContent = Number.isFinite(
      weather?.precipitationMm,
    )
      ? weather.precipitationMm.toFixed(1)
      : '—';
  }
  if (this.signalStream)
    this.signalStream.dataset.regionalStatus = payload?.status || 'partial';
  if (
    this.briefPageIndex === 1 &&
    this.briefSource &&
    this.newsCategory === 'regional'
  ) {
    this.briefSource.textContent = `${String(payload?.newsSource || 'REGIONAL NEWS').toUpperCase()} · LOCATION QUERY`;
  }
  this.scheduleContextLayout();
}
