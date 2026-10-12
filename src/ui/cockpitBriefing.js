/** Regional briefing requests, pages and rotation for the Cockpit controller. */
import {
  COCKPIT_BRIEF_ROTATE_MS,
  COCKPIT_BRIEF_CYCLE_OFF_HELP_KEY,
  COCKPIT_BRIEF_CYCLE_ON_HELP_KEY,
  COCKPIT_REGIONAL_REFRESH_MS,
  COCKPIT_REGIONAL_REFRESH_DISTANCE_M,
  COCKPIT_BRIEF_PAGES,
  formatCockpitBriefAge,
  formatCockpitWindDirection,
} from './cockpitPresentation.js';
import { t } from '../i18n/index.js';

// The weather-code labels arrive as stable English strings from the portable
// regional model (src/data/regionalModel.js); the presentation edge translates
// the known messages (docs/I18N.md rule 8) and passes unknown ones through.
const WEATHER_CODE_LABEL_KEYS = {
  'CONDITIONS UNKNOWN': 'cockpit.local.conditions.unknown',
  CLEAR: 'cockpit.local.conditions.clear',
  'PARTLY CLOUDY': 'cockpit.local.conditions.partlyCloudy',
  OVERCAST: 'cockpit.local.conditions.overcast',
  FOG: 'cockpit.local.conditions.fog',
  DRIZZLE: 'cockpit.local.conditions.drizzle',
  RAIN: 'cockpit.local.conditions.rain',
  SNOW: 'cockpit.local.conditions.snow',
  'RAIN SHOWERS': 'cockpit.local.conditions.rainShowers',
  'SNOW SHOWERS': 'cockpit.local.conditions.snowShowers',
  THUNDERSTORM: 'cockpit.local.conditions.thunderstorm',
  'MIXED CONDITIONS': 'cockpit.local.conditions.mixed',
};

function translateWeatherCodeLabel(label) {
  const key = WEATHER_CODE_LABEL_KEYS[label];
  return key ? t(key) : label;
}

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
  if (this.briefSource) this.briefSource.textContent = t(page.sourceKey);
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
    const label = this.briefAutoRotateEnabled
      ? t('cockpit.brief.cycleOn')
      : t('cockpit.brief.cycleOff');
    this.briefAutoToggle.textContent = label;
    const help = this.briefAutoRotateEnabled
      ? t(COCKPIT_BRIEF_CYCLE_ON_HELP_KEY)
      : t(COCKPIT_BRIEF_CYCLE_OFF_HELP_KEY);
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
    this.localCoordinates.textContent = t('cockpit.brief.positionUnavailable');
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
  if (this.newsStatus) {
    this.newsStatus.hidden = false;
    this.newsStatus.dataset.state = status;
    this.newsStatus.textContent =
      status === 'loading'
        ? t('cockpit.brief.acquiringNews')
        : t('cockpit.brief.newsUnavailable');
  }
  if (status === 'unavailable') this.newsList?.replaceChildren();
  if (this.localPlace && status === 'loading')
    this.localPlace.textContent = t('cockpit.brief.resolvingRegion');
  if (this.localPlace && status === 'unavailable')
    this.localPlace.textContent = t('cockpit.brief.regionUnavailable');
  this.updateLocalPosition(info);
}

export function renderRegionalBrief(payload, info) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  if (this.newsStatus) {
    this.newsStatus.hidden = articles.length > 0;
    this.newsStatus.dataset.state = payload?.newsStatus || 'unavailable';
    this.newsStatus.textContent =
      payload?.newsStatus === 'empty'
        ? t('cockpit.brief.noNewsMatches')
        : t('cockpit.brief.newsUnavailable');
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
        metadata.textContent = t('cockpit.brief.newsMeta', {
          source: article.domain || t('cockpit.brief.sourceFallback'),
          age: formatCockpitBriefAge(article.publishedAt),
        });
        link.append(title, metadata);
        entry.append(link);
        return entry;
      }),
    );
  }

  const placeLabel =
    payload?.place?.label ||
    payload?.place?.country ||
    t('cockpit.brief.regionUnavailable');
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
    this.localCondition.textContent = translateWeatherCodeLabel(
      this.services.weatherCodeLabel(weather?.weatherCode),
    );
  if (this.localCloud) {
    this.localCloud.textContent = Number.isFinite(weather?.cloudCoverPct)
      ? t('cockpit.local.cloud', { n: Math.round(weather.cloudCoverPct) })
      : t('cockpit.local.cloudUnknown');
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
  if (this.briefPageIndex === 1 && this.briefSource) {
    this.briefSource.textContent = t('cockpit.brief.newsSourceLine', {
      source: String(
        payload?.newsSource || t('cockpit.brief.newsSourceFallback'),
      ).toUpperCase(),
    });
  }
  this.scheduleContextLayout();
}
