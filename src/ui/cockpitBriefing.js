/** Regional briefing requests, pages and rotation for the Cockpit controller. */
import { formatNumber, t, msg } from '../i18n/index.js';
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
  newsWindowFooter,
} from './cockpitBriefPages.js';
import {
  recentRegionalArticles,
  regionalNewsWindowHours,
} from '../data/regionalNewsWindow.js';

const NEWS_ROWS = 4;

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
    // The news footer follows the news state, so it survives page changes.
    source:
      page.id === 'news'
        ? this.brief.news.footer
        : page.sourceKey
          ? t(page.sourceKey)
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
    this.renderRegionalBrief(this.regionalBrief, this.lastSubjectInfo);
  else if (this.brief.news.state)
    this.renderRegionalBriefStatus(this.brief.news.state, this.lastSubjectInfo);
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
  const subjectId = `${info.layerId || 'aircraft'}:${info.icao24 || (info.kind === 'vessel' || info.generic === true ? info.id : '') || info.noradId || info.registration || info.callsign || 'unknown'}`;
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

  // The brief held stands in after a failed refresh only near where its news
  // was read; past the refresh distance it is another place's.
  const previous =
    this.services.regionalDistanceM(this.regionalBriefPoint, point) <
    COCKPIT_REGIONAL_REFRESH_DISTANCE_M
      ? this.regionalBrief
      : null;
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
      this.regionalBrief = withCachedNews(payload, previous);
      if (this.regionalBrief === payload) this.regionalBriefPoint = point;
      this.renderRegionalBrief(this.regionalBrief, info);
    })
    .catch((error) => {
      if (
        error?.name !== 'AbortError' &&
        this.active &&
        requestToken === this.regionalBriefRequestToken &&
        subjectId === this.regionalBriefSubjectId
      ) {
        if (previous) {
          this.regionalBrief = cachedNews(previous, previous);
          this.renderRegionalBrief(this.regionalBrief, info);
        } else {
          // Another place's brief: not to come back with a language change.
          this.regionalBrief = null;
          this.renderRegionalBriefStatus('unavailable', info);
        }
      }
    })
    .finally(() => {
      if (this.regionalBriefAbort === controller)
        this.regionalBriefAbort = null;
    });
}

/**
 * A brief whose news comes from `previous` after a refresh that brought none:
 * the earlier articles stay, marked `cached` so they are labelled as such.
 * @param {object} payload The brief to keep everything else from.
 * @param {object} previous The last brief rendered for this subject.
 */
function cachedNews(payload, previous) {
  return {
    ...payload,
    newsStatus: 'cached',
    newsSource: previous.newsSource,
    newsWindowHours: previous.newsWindowHours,
    newsFetchedAt: previous.newsFetchedAt ?? previous.retrievedAt ?? null,
    articles: previous.articles,
  };
}

// A refresh whose news read failed keeps the articles from before it.
function withCachedNews(payload, previous) {
  return previous && payload?.newsStatus === 'unavailable'
    ? cachedNews(payload, previous)
    : payload;
}

/**
 * The Regional News state a brief presents. `ready` and `cached` have rows
 * inside the window; `cached` is a refresh that failed (a client-side failure,
 * or the local proxy's `stale` answer). `empty` is a source that answered with
 * nothing in the window; anything else is `unavailable`.
 * @returns {{state: string, status: string, footer: string, articles: object[]}}
 */
function regionalNewsView(payload) {
  const hours = regionalNewsWindowHours(payload?.newsWindowHours);
  // Old caches and the local path are held to the window here too.
  const articles = recentRegionalArticles(payload?.articles, {
    windowHours: hours,
    limit: NEWS_ROWS,
  });
  const source = String(
    payload?.newsSource || t('REGIONAL NEWS'),
  ).toUpperCase();
  const refreshFailed =
    payload?.newsStatus === 'cached' || payload?.status === 'stale';
  if (articles.length && refreshFailed)
    return {
      state: 'cached',
      status: t('CACHED · REFRESH FAILED'),
      footer: t('{source} · CACHED {age}', {
        source,
        age: formatCockpitBriefAge(
          payload?.newsFetchedAt ?? payload?.retrievedAt,
        ),
      }),
      articles,
    };
  const answered =
    !refreshFailed && ['ready', 'empty'].includes(payload?.newsStatus);
  return {
    state: articles.length ? 'ready' : answered ? 'empty' : 'unavailable',
    status: articles.length
      ? ''
      : answered
        ? t('NO NEWS IN THE LAST {hours} H', { hours })
        : t('REGIONAL NEWS UNAVAILABLE'),
    footer: newsWindowFooter(source, hours),
    articles,
  };
}

export function renderRegionalBriefStatus(status, info) {
  const { news, local } = this.brief;
  news.statusHidden = false;
  news.state = status;
  news.status =
    status === 'loading'
      ? t('ACQUIRING REGIONAL NEWS')
      : t('REGIONAL NEWS UNAVAILABLE');
  news.footer = newsWindowFooter();
  // Only called with no brief for this subject: any rows are another's.
  news.articles = [];
  if (this.briefPageIndex === 1) this.brief.source = news.footer;
  if (status === 'loading') local.place = t('RESOLVING REGION');
  if (status === 'unavailable') local.place = t('REGION UNAVAILABLE');
  local.coordinates = localCoordinates(info);
  this.publishBriefView();
}

export function renderRegionalBrief(payload, info) {
  const { state, status, footer, articles } = regionalNewsView(payload);
  const seen = new Map();
  const storyKey = (url) => {
    const count = seen.get(url) ?? 0;
    seen.set(url, count + 1);
    return count ? `${url}#${count}` : String(url);
  };
  const weather = payload?.weather;
  const condition = this.services.weatherCodeLabel(weather?.weatherCode);
  const conditionKey = WEATHER_CONDITION_KEYS[condition];
  const placeLabel =
    payload?.place?.label || payload?.place?.country || t('REGION UNAVAILABLE');
  this.brief.news = {
    statusHidden: state === 'ready',
    state,
    status,
    footer,
    articles: articles.map((article) => ({
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
    temperature: Number.isFinite(weather?.temperatureC)
      ? `${Math.round(weather.temperatureC)}°C`
      : '—',
    wind: Number.isFinite(weather?.windKph)
      ? t('{value} KM/H', { value: Math.round(weather.windKph) })
      : '—',
    windDirection: formatCockpitWindDirection(weather?.windDirectionDeg),
    condition: conditionKey ? t(conditionKey) : condition,
    cloud: Number.isFinite(weather?.cloudCoverPct)
      ? t('CLOUD {pct}%', { pct: Math.round(weather.cloudCoverPct) })
      : t('CLOUD UNKNOWN'),
    precipitation: Number.isFinite(weather?.precipitationMm)
      ? formatNumber(weather.precipitationMm, {
          useGrouping: false,
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })
      : '—',
  };
  this.brief.regionalStatus = payload?.status || 'partial';
  if (this.briefPageIndex === 1) this.brief.source = footer;
  this.publishBriefView();
  this.scheduleContextLayout();
}
