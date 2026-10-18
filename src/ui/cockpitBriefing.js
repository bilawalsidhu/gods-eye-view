/** Regional briefing requests, pages and rotation for the Cockpit controller. */
import { formatNumber, t, msg } from '../i18n/index.js';
import {
  COCKPIT_BRIEF_ROTATE_MS,
  COCKPIT_BRIEF_CYCLE_OFF_HELP,
  COCKPIT_BRIEF_CYCLE_ON_HELP,
  COCKPIT_REGIONAL_REFRESH_MS,
  COCKPIT_REGIONAL_REFRESH_DISTANCE_M,
  COCKPIT_BRIEF_PAGES,
  formatCockpitBriefAge,
  formatCockpitCoordinate,
  formatCockpitWindDirection,
} from './cockpitPresentation.js';

// regionalModel.weatherCodeLabel is shared with node code and returns
// English; translate it here.
const WEATHER_CONDITION_KEYS = Object.freeze({
  'CONDITIONS UNKNOWN': msg('CONDITIONS UNKNOWN'),
  CLEAR: msg('CLEAR'),
  'PARTLY CLOUDY': msg('PARTLY CLOUDY'),
  OVERCAST: msg('OVERCAST'),
  FOG: msg('FOG'),
  DRIZZLE: msg('DRIZZLE'),
  RAIN: msg('RAIN'),
  SNOW: msg('SNOW'),
  'RAIN SHOWERS': msg('RAIN SHOWERS'),
  'SNOW SHOWERS': msg('SNOW SHOWERS'),
  THUNDERSTORM: msg('THUNDERSTORM'),
  'MIXED CONDITIONS': msg('MIXED CONDITIONS'),
});

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
      ...[indicator, document.createTextNode(` ${t(page.kickerKey)}`)].filter(
        Boolean,
      ),
    );
  }
  if (this.briefSubtitle) this.briefSubtitle.textContent = t(page.subtitleKey);
  if (this.briefPosition)
    this.briefPosition.textContent = `${this.briefPageIndex + 1} / ${count}`;
  if (this.briefSource)
    this.briefSource.textContent = page.sourceKey
      ? t(page.sourceKey, { source: page.sourceName })
      : page.source;
  if (this.signalStream) this.signalStream.dataset.briefPage = page.id;
  if (manual && this.briefAutoRotateEnabled)
    this.startBriefRotation({ reset: true });
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
    // cockpitMarkup.test.mjs pins the English writes above; these translate
    // them.
    const labelKey = this.briefAutoRotateEnabled
      ? msg('CYCLE ON')
      : msg('CYCLE OFF');
    this.briefAutoToggle.textContent = t(labelKey);
    this.briefAutoToggle.setAttribute('aria-label', t(labelKey));
    this.briefAutoToggle.title = t(
      this.briefAutoRotateEnabled
        ? msg(
            'Stop automatic page cycling. Previous, Next, and the SIG/NEWS/LOCAL tabs stay available.',
          )
        : msg(
            'Cycle briefing pages automatically every 9 seconds (Signals → News → Local). Pauses while you hover or focus the panel. Live signal data refreshes continuously either way.',
          ),
    );
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
    this.localCoordinates.textContent = t('POSITION UNAVAILABLE');
    return;
  }
  const lat = formatCockpitCoordinate(info.latitude, 'N', 'S');
  const lon = formatCockpitCoordinate(info.longitude, 'E', 'W');
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
  if (this.newsStatus) {
    this.newsStatus.hidden = false;
    this.newsStatus.dataset.state = status;
    this.newsStatus.textContent =
      status === 'loading'
        ? t('ACQUIRING REGIONAL NEWS')
        : t('REGIONAL NEWS UNAVAILABLE');
  }
  if (status === 'unavailable') this.newsList?.replaceChildren();
  if (this.localPlace && status === 'loading')
    this.localPlace.textContent = t('RESOLVING REGION');
  if (this.localPlace && status === 'unavailable')
    this.localPlace.textContent = t('REGION UNAVAILABLE');
  this.updateLocalPosition(info);
}

export function renderRegionalBrief(payload, info) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  if (this.newsStatus) {
    this.newsStatus.hidden = articles.length > 0;
    this.newsStatus.dataset.state = payload?.newsStatus || 'unavailable';
    this.newsStatus.textContent =
      payload?.newsStatus === 'empty'
        ? t('NO RECENT LOCATION MATCHES')
        : t('REGIONAL NEWS UNAVAILABLE');
  }
  if (this.newsList) {
    this.newsList.replaceChildren(
      ...articles.slice(0, 4).map((article) => {
        const entry = document.createElement('li');
        const link = document.createElement('a');
        link.href = article.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const title = document.createElement('strong');
        title.textContent = article.title;
        const metadata = document.createElement('span');
        metadata.textContent = t('{domain} · {age}', {
          domain: article.domain || t('SOURCE'),
          age: formatCockpitBriefAge(article.publishedAt),
        });
        link.append(title, metadata);
        entry.append(link);
        return entry;
      }),
    );
  }

  const placeLabel =
    payload?.place?.label || payload?.place?.country || t('REGION UNAVAILABLE');
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
      ? t('{value} KM/H', { value: Math.round(weather.windKph) })
      : '—';
  }
  if (this.localWindDirection) {
    this.localWindDirection.textContent = formatCockpitWindDirection(
      weather?.windDirectionDeg,
    );
  }
  if (this.localCondition) {
    const condition = this.services.weatherCodeLabel(weather?.weatherCode);
    const conditionKey = WEATHER_CONDITION_KEYS[condition];
    this.localCondition.textContent = conditionKey
      ? t(conditionKey)
      : condition;
  }
  if (this.localCloud) {
    this.localCloud.textContent = Number.isFinite(weather?.cloudCoverPct)
      ? t('CLOUD {pct}%', {
          pct: Math.round(weather.cloudCoverPct),
        })
      : t('CLOUD UNKNOWN');
  }
  if (this.localPrecipitation) {
    this.localPrecipitation.textContent = Number.isFinite(
      weather?.precipitationMm,
    )
      ? formatNumber(weather.precipitationMm, {
          useGrouping: false,
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })
      : '—';
  }
  if (this.signalStream)
    this.signalStream.dataset.regionalStatus = payload?.status || 'partial';
  if (this.briefPageIndex === 1 && this.briefSource) {
    this.briefSource.textContent = t('{source} · LOCATION QUERY', {
      source: String(payload?.newsSource || t('REGIONAL NEWS')).toUpperCase(),
    });
  }
  this.scheduleContextLayout();
}
