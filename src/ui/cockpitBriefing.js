/** Regional briefing requests, pages and rotation for the Cockpit controller. */
import { isRecentDmhObservation } from '../data/regionalModel.js';
import { formatDate, formatNumber, t, msg } from '../i18n/index.js';
import {
  COCKPIT_BRIEF_ROTATE_MS,
  COCKPIT_REGIONAL_REFRESH_MS,
  COCKPIT_REGIONAL_REFRESH_DISTANCE_M,
  formatCockpitBriefAge,
  formatCockpitCoordinate,
  formatCockpitWindDirection,
} from './cockpitPresentation.js';
import {
  COCKPIT_BRIEF_PAGES,
  CYCLE_HELP_KEYS,
  createBriefState,
} from './cockpitBriefPages.js';

function localWeatherFooter(weather, observation) {
  const base =
    weather?.source === 'smn'
      ? t('NATURAL EARTH · SMN STATION OBSERVATION')
      : weather
        ? t('NATURAL EARTH · OPEN-METEO · UTC')
        : t('NATURAL EARTH · WEATHER UNAVAILABLE');
  return usableDmhObservation(observation)
    ? `${base} · ${t('DMH / DINAC · STATION OBSERVATION')}`
    : base;
}

function usableDmhObservation(observation) {
  return (
    isRecentDmhObservation(observation) &&
    Number.isFinite(observation?.distanceM) &&
    observation.distanceM >= 0 &&
    observation.distanceM <= 50_000
  );
}
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

/** Hand a fresh copy of the briefing to the view. */
export function publishBriefView() {
  const brief = this.brief;
  this.publishBrief({
    ...brief,
    news: { ...brief.news },
    local: { ...brief.local },
  });
}

export function showBriefPage(index, { manual = false } = {}) {
  if (this.destroyed) return;
  const count = COCKPIT_BRIEF_PAGES.length;
  this.briefPageIndex = ((Number(index) % count) + count) % count;
  const page = COCKPIT_BRIEF_PAGES[this.briefPageIndex];
  Object.assign(this.brief, {
    pageIndex: this.briefPageIndex,
    pageId: page.id,
    kicker: t(page.kickerKey),
    subtitle: t(page.subtitleKey),
    position: `${this.briefPageIndex + 1} / ${count}`,
    source:
      page.id === 'local'
        ? localWeatherFooter(
            this.regionalBrief?.weather,
            this.regionalBrief?.stationObservation,
          )
        : page.sourceKey
          ? t(page.sourceKey, { source: page.sourceName })
          : page.source,
  });
  this.publishBriefView();
  if (manual && this.briefAutoRotateEnabled)
    this.startBriefRotation({ reset: true });
  this.scheduleContextLayout();
}

// The state is the accessible name; the help is the tooltip.
function cycleWords(enabled) {
  return {
    autoRotate: enabled,
    autoLabel: enabled ? t('CYCLE ON') : t('CYCLE OFF'),
    autoHelp: t(CYCLE_HELP_KEYS[enabled ? 'on' : 'off']),
  };
}

/**
 * Word the briefing again in the current locale: its page, cycle toggle and
 * whatever the regional card shows.
 */
export function relocalizeBrief() {
  if (this.destroyed) return;
  if (this.brief.news.state === null) {
    const { news, local } = createBriefState();
    this.brief.news = news;
    this.brief.local = { ...local, coordinates: this.brief.local.coordinates };
  }
  Object.assign(this.brief, cycleWords(this.briefAutoRotateEnabled));
  this.showBriefPage(this.briefPageIndex);
  if (this.regionalBrief)
    this.renderRegionalBrief(this.regionalBrief, this.lastAircraftInfo);
  else if (this.brief.news.state)
    this.renderRegionalBriefStatus(
      this.brief.news.state,
      this.lastAircraftInfo,
    );
}

export function setBriefAutoRotate(enabled) {
  if (this.destroyed) return;
  this.briefAutoRotateEnabled = Boolean(enabled);
  Object.assign(this.brief, cycleWords(this.briefAutoRotateEnabled));
  this.publishBriefView();
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

/** @returns {string} The position line for the Local page. */
function localCoordinates(info) {
  if (!Number.isFinite(info.latitude) || !Number.isFinite(info.longitude))
    return t('POSITION UNAVAILABLE');
  const lat = formatCockpitCoordinate(info.latitude, 'N', 'S');
  const lon = formatCockpitCoordinate(info.longitude, 'E', 'W');
  return `${lat} · ${lon}`;
}

export function updateLocalPosition(info) {
  const coordinates = localCoordinates(info);
  if (coordinates === this.brief.local.coordinates) return;
  this.brief.local.coordinates = coordinates;
  this.publishBriefView();
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
  this.regionalBrief = null;
  this.brief.local = { ...createBriefState().local };
  renderLocalWeather.call(this, null);
  const { news, local } = this.brief;
  news.statusHidden = false;
  news.state = status;
  news.status =
    status === 'loading'
      ? t('ACQUIRING REGIONAL NEWS')
      : t('REGIONAL NEWS UNAVAILABLE');
  if (status === 'unavailable') news.articles = [];
  if (status === 'loading') local.place = t('RESOLVING REGION');
  if (status === 'unavailable') local.place = t('REGION UNAVAILABLE');
  local.coordinates = localCoordinates(info);
  this.publishBriefView();
}

export function renderRegionalBrief(payload, info) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  const seen = new Map();
  const storyKey = (url) => {
    const count = seen.get(url) ?? 0;
    seen.set(url, count + 1);
    return count ? `${url}#${count}` : String(url);
  };
  const weather = payload?.weather;
  const placeLabel =
    payload?.place?.label || payload?.place?.country || t('REGION UNAVAILABLE');
  this.brief.news = {
    statusHidden: articles.length > 0,
    state: payload?.newsStatus || 'unavailable',
    status:
      payload?.newsStatus === 'empty'
        ? t('NO RECENT LOCATION MATCHES')
        : t('REGIONAL NEWS UNAVAILABLE'),
    articles: articles.slice(0, 4).map((article) => ({
      // A row keeps its node, and so its focus, only for the same story.
      key: storyKey(article.url),
      url: article.url,
      title: article.title,
      meta: t('{domain} · {age}', {
        domain: article.domain || t('SOURCE'),
        age: formatCockpitBriefAge(article.publishedAt),
      }),
    })),
  };
  this.brief.local = {
    place: placeLabel.toUpperCase(),
    coordinates: localCoordinates(info),
  };
  this.regionalBrief = payload;
  renderLocalWeather.call(this, weather, payload?.stationObservation);
  this.brief.regionalStatus = payload?.status || 'partial';
  if (this.briefPageIndex === 1) {
    this.brief.source = t('{source} · LOCATION QUERY', {
      source: String(payload?.newsSource || t('REGIONAL NEWS')).toUpperCase(),
    });
  }
  this.publishBriefView();
  this.scheduleContextLayout();
}

function renderLocalWeather(weather, observation) {
  const local = this.brief.local;

  const usable = usableDmhObservation(observation);
  local.observationHidden = !usable;
  const values = [];
  if (Number.isFinite(observation?.temperatureC))
    values.push(
      `${formatNumber(observation.temperatureC, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°C`,
    );
  if (Number.isFinite(observation?.humidityPct))
    values.push(
      t('RH {percent}%', {
        percent: formatNumber(Math.round(observation.humidityPct)),
      }),
    );
  if (Number.isFinite(observation?.windKph))
    values.push(
      t('WIND {speed} KM/H {direction}', {
        speed: formatNumber(Math.round(observation.windKph)),
        direction: formatCockpitWindDirection(observation.windDirectionDeg),
      }),
    );
  local.observation = usable
    ? [
        t('DMH / DINAC · STATION OBSERVATION'),
        t('{station} · {distance} KM FROM LOCATION', {
          station: observation.stationName,
          distance: formatNumber(observation.distanceM / 1000, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        }),
        values.join(' · '),
        `${formatDate(new Date(observation.observedAt), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC · ${formatCockpitBriefAge(observation.observedAt)}`,
      ].join('\n')
    : '';

  local.temperature = Number.isFinite(weather?.temperatureC)
    ? `${Math.round(weather.temperatureC)}°C`
    : '—';

  local.wind = Number.isFinite(weather?.windKph)
    ? t('{value} KM/H', { value: Math.round(weather.windKph) })
    : '—';

  local.windDirection = formatCockpitWindDirection(weather?.windDirectionDeg);

  const condition =
    weather?.conditionText ||
    (weather
      ? this.services.weatherCodeLabel(weather.weatherCode)
      : 'CONDITIONS UNKNOWN');
  const conditionKey = WEATHER_CONDITION_KEYS[condition];
  local.condition = conditionKey ? t(conditionKey) : condition;

  local.cloud = Number.isFinite(weather?.cloudCoverPct)
    ? t('CLOUD {pct}%', {
        pct: Math.round(weather.cloudCoverPct),
      })
    : t('CLOUD UNKNOWN');

  local.precipitation = Number.isFinite(weather?.precipitationMm)
    ? formatNumber(weather.precipitationMm, {
        useGrouping: false,
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    : '—';

  const isSmn = weather?.source === 'smn';
  // i18n-ignore: OPEN-METEO is the provider brand; other branches use t().
  local.weatherSource = isSmn
    ? t('SMN OBS')
    : weather
      ? 'OPEN-METEO'
      : t('UNAVAILABLE');

  local.weatherStationHidden = !isSmn;
  const station = weather?.station;
  const distance = Number.isFinite(station?.distanceKm)
    ? t('{distance} KM FROM QUERY', {
        distance: formatNumber(station.distanceKm, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }),
      })
    : t('DISTANCE UNKNOWN');
  local.weatherStation = isSmn
    ? t('SMN · {station} · {distance}', {
        station: station?.name || t('UNKNOWN STATION'),
        distance,
      })
    : '';
  local.weatherStationTitle = isSmn
    ? t(
        'Ground station {id}; conditions may differ at the selected position and flight altitude.',
        { id: station?.id || '' },
      )
    : '';

  local.weatherTimeHidden = !weather;
  local.weatherTime = isSmn
    ? t('REPORTED {time} · TIME ZONE UNSPECIFIED', {
        time: weather.reportedAt?.replace('T', ' ') || t('UNKNOWN'),
      })
    : weather?.observedAt
      ? t('MODEL {time} UTC', {
          time: weather.observedAt
            .replace('T', ' ')
            .replace(/:00(?:\.000)?Z$/, ''),
        })
      : t('TIME UNKNOWN');

  local.weatherCredit = isSmn
    ? t('Atmospheric model by Open-Meteo.com')
    : t('Weather data by Open-Meteo.com');
  if (this.briefPageIndex === 2)
    this.brief.source = localWeatherFooter(weather, observation);
}
