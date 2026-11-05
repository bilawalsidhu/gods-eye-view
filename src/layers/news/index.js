import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../../data/contextStore.js';
import { msg, t, tn } from '../../i18n/index.js';
import { createHorizonCull, viewCentre } from '../streetLevel/view.js';
import {
  NEWS_CARD_MIN_SOURCES,
  NEWS_CATEGORIES,
  NEWS_DETAIL_MAX_HEIGHT_M,
  NEWS_FEED_PAGE,
  NEWS_FOCUS_HEIGHT_M,
  NEWS_IN_VIEW_MAX_HEIGHT_M,
  NEWS_LAYER_ID,
  NEWS_MAP_LIMIT,
  NEWS_OVERLAY_SOURCE_ID,
  NEWS_PICK_PREFIX,
  NEWS_RELEVANT,
  NEWS_SETTLE_MS,
  NEWS_SEVERITY,
  ageWords,
  attestation,
  beaconPixelSize,
  cardEvents,
  cardView,
  categoryLabel,
  disputedLabel,
  feedCardView,
  feedQueryFor,
  hotspotLabel,
  hotspotTrend,
  isPressing,
  markerStyle,
  mediaLabels,
  mergeFeedPage,
  normalizeFilters,
  passesFilters,
  reportMarkerPosition,
  reportsInView,
  severityStyle,
  shortTitle,
  sideLabel,
  sidesLine,
  sourceLinkLabel,
  viewCell,
  visibleOnMap,
  withinNewsWindow,
} from './model.js';
import { SPRITE_SCALE, markerSprite } from './sprites.js';
import { CARD_H, CARD_W, eventCard } from './cards.js';
export * from './model.js';
export { createNewsSource } from './source.js';

const FEED_UNAVAILABLE = msg('News feed unavailable');
const REPORT_PREFIX = `${NEWS_PICK_PREFIX}report:`;
const HOTSPOT_PREFIX = `${NEWS_PICK_PREFIX}hotspot:`;
const DEVELOPING_PREFIX = `${NEWS_PICK_PREFIX}developing:`;
const DEVELOPING_COLOR = '#ffb020';
// Disputed areas: dotted, in their own colour, apart from ordinary borders.
const DISPUTED_COLOR = '#f472b6';
const HOTSPOT_COLOR = '#00d4ff';
// A filtered feed page that shows almost nothing reads the next page by
// itself, a few times, so a strict severity floor still fills the list.
const AUTO_PAGES = 3;
const PULSE_MS = 1_600;
const emptyFeed = () => ({
  items: [],
  nextBefore: null,
  loading: false,
  error: null,
});
const emptyInView = () => ({
  active: false,
  cell: null,
  centre: null,
  reports: [],
  loading: false,
  error: null,
});

/**
 * News from curated hotspots, real time only (the last 24 hours). Zoomed out:
 * one beacon per hotspot with its daily count and trend, and a breathing
 * beacon per developing situation. Close up or with a hotspot chosen:
 * outlines (disputed areas dotted) and the geocoded reports as markers, the
 * big events as picture cards. The News panel renders the feed this layer
 * publishes through getRowControls().feed.
 */
export function createNewsLayer({
  source,
  overlayHost,
  cesium = Cesium,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  now = () => Date.now(),
  hitTestOverlay = hitTestWorldOverlay,
  openUrl = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  getViewCentre = viewCentre,
} = {}) {
  if (
    typeof source?.getHotspots !== 'function' ||
    typeof source?.getFeed !== 'function'
  )
    throw new TypeError('News requires a news source');
  if (!overlayHost) throw new TypeError('News requires an overlay host');

  let viewer = null,
    dataSource = null,
    outlineSource = null,
    clickHandler = null,
    listener = null,
    runNavigation = null,
    request = null,
    feedRequest = null,
    inViewRequest = null,
    settleTimer = null,
    pulseTimer = null,
    removeCameraListener = null;
  let enabled = false,
    destroyed = false,
    loading = false,
    unavailable = false,
    error = null,
    lastUpdate = null,
    lastRunAt = null,
    autoPages = 0;
  let hotspots = [];
  let mapReports = [];
  let feed = emptyFeed();
  let inView = emptyInView();
  let filters = normalizeFilters();
  let selectedId = null,
    selectedPin = 0;
  let shownDetail = null;
  let cullTargets = [];
  const contextEntities = new Map();
  const notify = () => listener?.();
  const requestRender = () => viewer?.scene?.requestRender?.();
  const reducedMotion = () =>
    Boolean(matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  const findReport = (id) =>
    mapReports.find((r) => r.id === id) ||
    feed.items.find((r) => r.id === id) ||
    inView.reports.find((r) => r.id === id) ||
    null;
  const selected = () => (selectedId ? findReport(selectedId) : null);
  const onMap = (report) => visibleOnMap(report, filters, now());

  function markerCartesian(report, pin = 0) {
    const { lat, lon } = reportMarkerPosition(report, pin);
    return cesium.Cartesian3.fromDegrees(lon, lat);
  }

  const cameraHeight = () => viewer?.camera?.positionCartographic?.height;

  // Global view: one beacon per hotspot. Close up: outlines and individual
  // reports. A chosen hotspot keeps the detail out to three times the height
  // (its whole area fits on screen).
  function detailMode() {
    const height = cameraHeight();
    if (!Number.isFinite(height)) return filters.hotspot !== 'all';
    const limit =
      filters.hotspot === 'all'
        ? NEWS_DETAIL_MAX_HEIGHT_M
        : NEWS_DETAIL_MAX_HEIGHT_M * 3;
    return height < limit;
  }

  // The catch-all ("Elsewhere") has no area to stand for: its reports are
  // drawn as markers at every zoom instead of a beacon or an outline.
  const catchAllIds = () =>
    new Set(hotspots.filter((h) => h.catchAll).map((h) => h.id));

  // Markers draw over terrain (depth test off) so a pin is never swallowed by
  // the ground it sits on; the shared horizon cull hides the far side.
  const horizon = createHorizonCull({
    getViewer: () => viewer,
    items: () => cullTargets,
    onChange: () => {
      requestRender();
      updatePulse();
    },
  });

  // A developing situation's beacon breathes, unless motion is reduced. The
  // scene renders on demand, so a slow timer asks for frames only while such
  // a beacon is in view.
  const pulseSize = (size) =>
    size *
    (1 + 0.35 * (0.5 + 0.5 * Math.sin((Date.now() / PULSE_MS) * 2 * Math.PI)));
  function updatePulse() {
    const pulsing =
      enabled &&
      !reducedMotion() &&
      cullTargets.some((target) => target.developing && target.show);
    if (pulsing && !pulseTimer) pulseTimer = setInterval(requestRender, 250);
    else if (!pulsing && pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
  }

  const ambientLabel = (extra) => ({
    variant: 'label',
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    horizonCull: true,
    terrainOcclusion: false,
    placement: 'above',
    ...extra,
  });

  // Several separate events in one country outside every hotspot.
  function renderDeveloping(hotspot, entities, labels) {
    const still = reducedMotion();
    for (const item of hotspot.developing || []) {
      const position = cesium.Cartesian3.fromDegrees(
        item.focus.lon,
        item.focus.lat,
      );
      const size = beaconPixelSize(item.reports);
      entities.add({
        id: `${DEVELOPING_PREFIX}${hotspot.id}:${item.key}`,
        position,
        point: {
          pixelSize: still
            ? size
            : new cesium.CallbackProperty(() => pulseSize(size), false),
          color:
            cesium.Color.fromCssColorString(DEVELOPING_COLOR).withAlpha(0.35),
          outlineColor: cesium.Color.fromCssColorString(DEVELOPING_COLOR),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      labels.push(
        ambientLabel({
          id: `developing:${item.key}`,
          position,
          title: t('Developing: {name}', { name: item.name }),
          details: [
            tn(item.events, '{count} event today', '{count} events today'),
          ],
          accent: DEVELOPING_COLOR,
          priority: 9_000 + item.reports,
          gapPx: size / 2 + 4,
        }),
      );
    }
  }

  function renderBeacons(entities, labels) {
    for (const hotspot of hotspots) {
      if (hotspot.catchAll) {
        renderDeveloping(hotspot, entities, labels);
        continue;
      }
      const { lat, lon } = hotspot.focus;
      const position = cesium.Cartesian3.fromDegrees(lon, lat);
      entities.add({
        id: `${HOTSPOT_PREFIX}${hotspot.id}`,
        position,
        point: {
          pixelSize: beaconPixelSize(hotspot.last24h),
          color: cesium.Color.fromCssColorString(HOTSPOT_COLOR).withAlpha(0.35),
          outlineColor: cesium.Color.fromCssColorString(HOTSPOT_COLOR),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      const trend = hotspotTrend(hotspot.last24h, hotspot.prev24h);
      labels.push(
        ambientLabel({
          id: `hotspot:${hotspot.id}`,
          position,
          title: hotspotLabel(hotspot),
          details: [
            `${tn(hotspot.last24h, '{count} report today', '{count} reports today')}${trend ? ` ${trend}` : ''}`,
          ],
          accent: HOTSPOT_COLOR,
          priority: 10_000 + hotspot.last24h,
          gapPx: beaconPixelSize(hotspot.last24h) / 2 + 4,
        }),
      );
    }
  }

  function renderHotspotOutlines(entities, labels) {
    for (const hotspot of hotspots) {
      if (hotspot.catchAll) continue;
      const [w, s, e, n] = hotspot.bbox;
      const active = filters.hotspot === hotspot.id;
      // The bounding box only until the real outline has loaded.
      if (!outlineParts.has(hotspot.id))
        entities.add({
          id: `${HOTSPOT_PREFIX}${hotspot.id}`,
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArray([
              w,
              s,
              e,
              s,
              e,
              n,
              w,
              n,
              w,
              s,
            ]),
            width: active ? 3 : 2,
            clampToGround: true,
            material: new cesium.PolylineDashMaterialProperty({
              color: cesium.Color.fromCssColorString(HOTSPOT_COLOR).withAlpha(
                active ? 0.95 : 0.55,
              ),
              dashLength: 18,
            }),
          },
        });
      labels.push(
        ambientLabel({
          id: `hotspot:${hotspot.id}`,
          position: outlineParts.has(hotspot.id)
            ? cesium.Cartesian3.fromDegrees(
                hotspot.focus.lon,
                hotspot.focus.lat,
              )
            : cesium.Cartesian3.fromDegrees(w, n),
          title: hotspotLabel(hotspot),
          details: [
            tn(
              hotspot.last24h,
              '{count} report today',
              '{count} reports today',
            ),
          ],
          accent: HOTSPOT_COLOR,
          priority: 10_000 + hotspot.last24h,
        }),
      );
      // Each disputed area is named, with who holds it and who claims it.
      for (const area of outlineDisputed.get(hotspot.id) || []) {
        const ring = area.rings[0];
        const lon = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
        const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
        const label = disputedLabel(area);
        labels.push(
          ambientLabel({
            id: `disputed:${hotspot.id}:${area.name}`,
            position: cesium.Cartesian3.fromDegrees(lon, lat),
            title: label.title,
            details: [label.detail],
            accent: DISPUTED_COLOR,
            priority: 8_000,
          }),
        );
      }
    }
  }

  function renderMarkers(entities, drawn) {
    for (const report of drawn) {
      const isSelected = report.id === selectedId;
      if (!report.pins.length || (!isSelected && !onMap(report))) continue;
      // One marker per pin; the pin index rides on the pick id. Fill is
      // severity, the icon the category, the rim attestation; a marker grows
      // with the sources reporting its event and fades with age. A fresh,
      // widely reported or major event also gets a static halo.
      const look = markerStyle(report, now());
      const color = cesium.Color.fromCssColorString(
        severityStyle(report).color,
      );
      const size = isSelected ? look.size + 4 : look.size;
      const sprite = markerSprite({ ...look, selected: isSelected });
      const pressing = isPressing(report, now());
      for (const [pin] of report.pins.entries()) {
        const position = markerCartesian(report, pin);
        if (pressing)
          entities.add({
            id: `${REPORT_PREFIX}${report.id}~${pin}~halo`,
            position,
            point: {
              pixelSize: look.size * 2.4,
              color: color.withAlpha(0.22),
              outlineColor: color.withAlpha(0.6),
              outlineWidth: 1,
              heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        entities.add({
          id: `${REPORT_PREFIX}${report.id}~${pin}`,
          position,
          ...(sprite
            ? {
                billboard: {
                  image: sprite,
                  width: Math.round(size * SPRITE_SCALE),
                  height: Math.round(size * SPRITE_SCALE),
                  color: cesium.Color.WHITE.withAlpha(
                    isSelected ? 1 : look.alpha,
                  ),
                  heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
              }
            : {
                point: {
                  pixelSize: size,
                  color,
                  outlineColor: isSelected
                    ? cesium.Color.WHITE
                    : cesium.Color.BLACK.withAlpha(0.7),
                  outlineWidth: isSelected ? 3 : 1.5,
                  heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
              }),
        });
      }
    }
  }

  // The big events stand as picture cards over their marker, unless the
  // reader has turned them off; never two on top of each other. The clicked
  // event shows its picture card either way, under its marker, with its text
  // card above.
  function pictureCards(drawn, current, labels) {
    const cardable = filters.cards
      ? cardEvents(
          drawn.filter((r) => r.id !== selectedId && onMap(r)),
          now(),
        )
      : [];
    const pictured =
      current?.pins.length &&
      current.event?.size >= NEWS_CARD_MIN_SOURCES &&
      current.pins[selectedPin]
        ? [current]
        : [];
    for (const [rank, report] of [...pictured, ...cardable].entries()) {
      const isSelected = report.id === selectedId;
      const look = markerStyle(report, now());
      const view = cardView(report, now());
      const image = eventCard(
        report.event?.id || report.id,
        view,
        look,
        requestRender,
      );
      if (!image) continue;
      const color = severityStyle(report).color;
      labels.push({
        id: `event-card:${report.id}`,
        position: markerCartesian(report, isSelected ? selectedPin : 0),
        variant: 'thumbnail',
        paintLane: 'thumbnail',
        title: '',
        details: [],
        image,
        accent: color,
        priority: isSelected ? Number.MAX_SAFE_INTEGER - 1 : 500_000 - rank,
        collisionGroup: isSelected ? 'news-selected-picture' : 'ambient-card',
        interactive: true,
        accessibilityLabel: `${view.title}. ${view.meta}`,
        activate: () => layer.setParams({ reportId: report.id, pin: 0 }),
        horizonCull: true,
        terrainOcclusion: false,
        placement: isSelected ? 'below' : 'above',
        verticalOnly: true,
        gapPx: look.size / 2 + 12,
        leaderOffsetPx: look.size / 2 + 2,
        viewportPadding: 24,
        // The collision box: rectangle overlap alone lets the cards of nearby
        // anchors stack.
        minAnchorSeparationPx: isSelected ? 0 : CARD_W * 0.85,
        thumbnailWidth: CARD_W,
        thumbnailHeight: CARD_H,
        thumbnailPadX: 0,
        thumbnailPadTop: 0,
        thumbnailPadBottom: 0,
        thumbnailTitleGap: 0,
        thumbnailTitleHeight: 0,
        thumbnailTitleChars: 0,
        thumbnailBackground: 'rgba(0, 0, 0, 0)',
        thumbnailLeaderColor: color,
        thumbnailRuleHeight: 0,
        thumbnailRadius: 4,
      });
    }
  }

  // The selected report's card: what, where, how attested, and the link to
  // the original article ("Source: host ↗"), which a click on it opens.
  function selectedCard(report, labels) {
    if (!report?.pins.length) return;
    const pin = report.pins[selectedPin] ? selectedPin : 0;
    labels.push({
      id: `selected-report:${report.id}`,
      position: markerCartesian(report, pin),
      variant: 'card',
      title: shortTitle(report.titleEn || report.title),
      details: [
        [
          report.publisher,
          sideLabel(report.side),
          ageWords(report.publishedAt, now()),
        ]
          .filter(Boolean)
          .join(' · '),
        [
          categoryLabel(report.category),
          t(severityStyle(report).label),
          report.pins[pin].place,
        ]
          .filter(Boolean)
          .join(' · '),
        sidesLine(report),
        attestation(report)?.label || '',
        mediaLabels(report).join(' · '),
        sourceLinkLabel(report.url),
      ].filter(Boolean),
      accent: severityStyle(report).color,
      selected: true,
      stateless: true,
      priority: Number.MAX_SAFE_INTEGER,
      interactive: true,
      accessibilityLabel: sourceLinkLabel(report.url),
      activate: () => {
        openUrl(report.url);
        return true;
      },
      horizonCull: true,
      terrainOcclusion: false,
      placement: 'above',
      gapPx: 12,
    });
  }

  function render() {
    if (!dataSource) return;
    const entities = dataSource.entities;
    // Removed before events are suspended: a marker removed and re-added
    // under the same id in one suspended batch reaches Cesium's visualizers
    // as "changed", and they keep drawing the removed entity (i.e. nothing).
    entities.removeAll();
    entities.suspendEvents();
    const labels = [];
    const detail = detailMode();
    shownDetail = detail;
    if (detail) renderHotspotOutlines(entities, labels);
    else renderBeacons(entities, labels);
    // A report picked in the feed or In view still gets its marker.
    const current = selected();
    const elsewhere = catchAllIds();
    const shown = detail
      ? mapReports
      : mapReports.filter((r) => elsewhere.has(r.hotspotId));
    const drawn =
      current && !shown.some((r) => r.id === current.id)
        ? [...shown, current]
        : shown;
    renderMarkers(entities, drawn);
    entities.resumeEvents();
    showOutlines(detail);
    const at = cesium.JulianDate.now();
    cullTargets = entities.values
      .filter((entity) => (entity.point || entity.billboard) && entity.position)
      .map((entity) => ({
        position: entity.position.getValue(at),
        developing: String(entity.id).startsWith(DEVELOPING_PREFIX),
        get show() {
          return entity.show;
        },
        set show(value) {
          entity.show = value;
        },
      }))
      .filter((target) => target.position);
    horizon.update();
    updatePulse();
    pictureCards(drawn, current, labels);
    selectedCard(current, labels);
    if (enabled)
      overlayHost.setEntries(NEWS_OVERLAY_SOURCE_ID, labels, { moving: false });
    requestRender();
  }

  function registerContext(report) {
    const place = report?.pins[selectedPin] || report?.geo;
    if (!place) return null;
    let entity = contextEntities.get(report.id);
    if (!entity) {
      entity = { show: true };
      contextEntities.set(report.id, entity);
    }
    const { lat, lon } = reportMarkerPosition(
      report,
      report.pins[selectedPin] ? selectedPin : 0,
    );
    entity.__localBaseCartesian = cesium.Cartesian3.fromDegrees(lon, lat);
    registerEntityContext(entity, {
      id: `news-report:${report.id}`,
      layerId: NEWS_LAYER_ID,
      layerName: 'News',
      source: report.publisher,
      dataSource,
      label: report.title, // i18n-ignore: publisher headline (data)
      latitude: place.lat,
      longitude: place.lon,
      properties: {
        publisher: report.publisher,
        side: report.side,
        category: report.category,
        place: place.place,
        publishedAt: report.publishedAt,
        url: report.url,
      },
    });
    return entity;
  }

  function select(id, pin = 0) {
    selectedId = id;
    selectedPin = pin;
    const report = selected();
    if (report) {
      const entity = registerContext(report);
      if (entity) selectEntityContext(entity);
    } else clearSelectedEntityContextForLayer(NEWS_LAYER_ID);
    render();
    notify();
  }

  function flyTo(navigate) {
    if (!runNavigation || !viewer) return;
    runNavigation(() => (enabled && !destroyed ? navigate() : undefined));
  }

  // A card's click: straight down over the event from 150 km.
  function focusReport(report) {
    if (!report?.pins.length) return;
    const { lat, lon } = report.pins[selectedPin] || report.pins[0];
    flyTo(() =>
      viewer.camera.flyTo({
        destination: cesium.Cartesian3.fromDegrees(
          lon,
          lat,
          NEWS_FOCUS_HEIGHT_M,
        ),
        duration: reducedMotion() ? 0 : 1.4,
      }),
    );
  }

  function focusRectangle([w, s, e, n]) {
    flyTo(() =>
      viewer.camera.flyTo({
        destination: cesium.Rectangle.fromDegrees(w, s, e, n),
        duration: reducedMotion() ? 0 : 1.6,
      }),
    );
  }

  // Hotspot extents (and developing countries) are drawn in their own data
  // source, built once per outline and only shown or hidden afterwards:
  // ground polygons over 3D tiles are slow to build, so they are never
  // rebuilt on a re-render. A hotspot's fill clears when it is the chosen
  // one so its border stays readable over the reports inside.
  const outlineParts = new Map();
  const outlineRequests = new Set();
  const outlineDisputed = new Map();
  function addOutline(
    key,
    { polygons, borders, disputed = [] },
    { color, fillAlpha, pickId },
  ) {
    if (!outlineSource || outlineParts.has(key)) return;
    const css = cesium.Color.fromCssColorString(color);
    const parts = { fills: [], borders: [] };
    const ring = (points) => cesium.Cartesian3.fromDegreesArray(points.flat());
    const closed = (points) => ring([...points, points[0]]);
    const line = (id, positions, width, material) =>
      parts.borders.push(
        outlineSource.entities.add({
          id,
          show: false,
          polyline: { positions, width, clampToGround: true, material },
        }),
      );
    for (const [index, polygon] of polygons.entries()) {
      if (fillAlpha > 0)
        parts.fills.push(
          outlineSource.entities.add({
            id: `${pickId}~fill${index}`,
            show: false,
            polygon: {
              hierarchy: new cesium.PolygonHierarchy(
                ring(polygon.outer),
                polygon.holes.map(
                  (hole) => new cesium.PolygonHierarchy(ring(hole)),
                ),
              ),
              material: css.withAlpha(fillAlpha),
              classificationType: cesium.ClassificationType.BOTH,
            },
          }),
        );
      for (const [k, points] of [polygon.outer, ...polygon.holes].entries())
        line(
          `${pickId}~line${index}.${k}`,
          closed(points),
          2,
          css.withAlpha(0.85),
        );
    }
    // National borders inside a multi-country hotspot: thin and dashed.
    for (const [index, points] of borders.entries())
      line(
        `${pickId}~border${index}`,
        closed(points),
        1.5,
        new cesium.PolylineDashMaterialProperty({
          color: css.withAlpha(0.6),
          dashLength: 12,
        }),
      );
    const dotted = new cesium.PolylineDashMaterialProperty({
      color: cesium.Color.fromCssColorString(DISPUTED_COLOR).withAlpha(0.9),
      dashLength: 6,
    });
    for (const [index, area] of disputed.entries())
      for (const [k, points] of area.rings.entries())
        line(`${pickId}~disputed${index}.${k}`, closed(points), 2, dotted);
    outlineDisputed.set(key, disputed);
    outlineParts.set(key, parts);
  }
  function loadOutline(key, fetchOutline, style) {
    if (outlineParts.has(key) || outlineRequests.has(key) || !fetchOutline)
      return;
    outlineRequests.add(key);
    fetchOutline()
      .then((outline) => {
        if (destroyed) return;
        addOutline(key, outline, style);
        if (enabled) render();
      })
      // An outline is an extra: the bounding box stands in for it.
      .catch(() => {})
      .finally(() => outlineRequests.delete(key));
  }
  function loadOutlines() {
    for (const hotspot of hotspots) {
      if (!hotspot.catchAll)
        loadOutline(
          hotspot.id,
          source.getOutline && (() => source.getOutline(hotspot.id)),
          {
            color: HOTSPOT_COLOR,
            fillAlpha: 0.08,
            pickId: `${HOTSPOT_PREFIX}${hotspot.id}`,
          },
        );
      for (const item of hotspot.developing || [])
        loadOutline(
          `developing:${item.key}`,
          source.getCountryOutline &&
            (() => source.getCountryOutline(item.key)),
          {
            color: DEVELOPING_COLOR,
            fillAlpha: 0,
            pickId: `${DEVELOPING_PREFIX}${hotspot.id}:${item.key}`,
          },
        );
    }
  }
  function showOutlines(detail) {
    const developing = new Set(
      hotspots.flatMap((h) => (h.developing || []).map((d) => d.key)),
    );
    for (const [key, parts] of outlineParts) {
      const country = key.startsWith('developing:') ? key.slice(11) : null;
      const visible = enabled && (country ? developing.has(country) : detail);
      const fill = visible && !country && filters.hotspot !== key;
      for (const entity of parts.fills)
        if (entity.show !== fill) entity.show = fill;
      for (const entity of parts.borders)
        if (entity.show !== visible) entity.show = visible;
    }
  }

  const shownCount = () =>
    feed.items.filter((r) => passesFilters(r, filters, now())).length;

  async function loadFeed(mode) {
    if (!enabled || unavailable) return;
    if (mode === 'append' && (!feed.nextBefore || feed.loading)) return;
    if (mode === 'replace') autoPages = 0;
    feedRequest?.abort();
    const controller = new AbortController();
    feedRequest = controller;
    feed = { ...feed, loading: true, error: null };
    notify();
    try {
      const page = await source.getFeed(
        feedQueryFor(
          filters,
          mode === 'append' ? { before: feed.nextBefore } : {},
        ),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || feedRequest !== controller || !enabled)
        return;
      feed = {
        ...mergeFeedPage(feed, page, mode),
        loading: false,
        error: null,
      };
    } catch (cause) {
      if (controller.signal.aborted || feedRequest !== controller) return;
      feed = {
        ...feed,
        loading: false,
        error: cause?.message || FEED_UNAVAILABLE,
      };
    } finally {
      if (feedRequest === controller) feedRequest = null;
      notify();
    }
    if (
      enabled &&
      !feed.error &&
      feed.nextBefore &&
      shownCount() < NEWS_FEED_PAGE / 3 &&
      autoPages < AUTO_PAGES
    ) {
      autoPages++;
      void loadFeed('append');
    }
  }

  // "In view": below 3,000 km, the reports within 500 km of the view centre,
  // read again once the camera has settled for 0.8 s in another half-degree
  // cell. The feed has no area query, so the last day's geocoded reports are
  // read and kept by distance here.
  function scheduleInView() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void refreshInView();
    }, NEWS_SETTLE_MS);
  }
  async function refreshInView({ force = false } = {}) {
    if (!enabled || unavailable) return;
    const height = cameraHeight();
    if (!(height < NEWS_IN_VIEW_MAX_HEIGHT_M)) {
      if (inView.active) {
        inViewRequest?.abort();
        inViewRequest = null;
        inView = emptyInView();
        notify();
      }
      return;
    }
    const centre = getViewCentre(viewer);
    if (!centre) return;
    const cell = viewCell(centre);
    if (!force && inView.active && cell === inView.cell) return;
    inViewRequest?.abort();
    const controller = new AbortController();
    inViewRequest = controller;
    inView = { ...inView, active: true, cell, centre, loading: true };
    notify();
    try {
      const page = await source.getFeed(
        {
          hotspot: 'all',
          geo: true,
          today: true,
          events: true,
          relevance: filters.includeMinor ? '' : NEWS_RELEVANT,
          limit: NEWS_MAP_LIMIT,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || inViewRequest !== controller) return;
      inView = {
        ...inView,
        reports: page.reports,
        loading: false,
        error: null,
      };
    } catch (cause) {
      if (controller.signal.aborted || inViewRequest !== controller) return;
      inView = {
        ...inView,
        loading: false,
        error: cause?.message || FEED_UNAVAILABLE,
      };
    } finally {
      if (inViewRequest === controller) inViewRequest = null;
      notify();
    }
  }

  function installSelection() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    clickHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      if (!enabled || destroyed || !isPointerFree() || !click?.position) return;
      const card = hitTestOverlay(click.position.x, click.position.y, {
        sourceId: NEWS_OVERLAY_SOURCE_ID,
      });
      if (card?.entry?.activate) {
        card.entry.activate();
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const id = picked ? resolvePickId(picked) : null;
      if (typeof id === 'string' && id.startsWith(REPORT_PREFIX)) {
        const [reportId, pin] = id.slice(REPORT_PREFIX.length).split('~');
        layer.setParams({ reportId, pin: Number(pin) || 0 });
        return;
      }
      if (typeof id === 'string' && id.startsWith(DEVELOPING_PREFIX)) {
        const [hotspotId, key] = id
          .slice(DEVELOPING_PREFIX.length)
          .split('~')[0]
          .split(':');
        const item = hotspots
          .find((h) => h.id === hotspotId)
          ?.developing?.find((d) => d.key === key);
        layer.setParams({ filters: { hotspot: hotspotId } });
        if (item) {
          const { lat, lon } = item.focus;
          focusRectangle([
            lon - 5,
            Math.max(-85, lat - 3.5),
            lon + 5,
            Math.min(85, lat + 3.5),
          ]);
        }
        return;
      }
      if (typeof id === 'string' && id.startsWith(HOTSPOT_PREFIX)) {
        const hotspotId = id.slice(HOTSPOT_PREFIX.length).split('~')[0];
        // Clicking the hotspot already in focus steps out of a report.
        if (filters.hotspot === hotspotId) {
          if (selectedId) layer.setParams({ clear: true });
          return;
        }
        layer.setParams({ filters: { hotspot: hotspotId } });
        return;
      }
      if (id && isOwnedByOtherLayer(NEWS_LAYER_ID, id)) return;
      if (selectedId && !picked?.id) layer.setParams({ clear: true });
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    if (clickHandler && !clickHandler.isDestroyed?.()) clickHandler.destroy();
    clickHandler = null;
  }

  function feedView() {
    const at = now();
    const report = selected();
    const total = hotspots.reduce((sum, h) => sum + h.last24h, 0);
    return {
      filters,
      hotspots: [
        { id: 'all', label: t('All'), count: total },
        ...hotspots.map((hotspot) => ({
          id: hotspot.id,
          label: hotspotLabel(hotspot),
          count: hotspot.last24h,
        })),
      ].map((chip) => ({ ...chip, active: filters.hotspot === chip.id })),
      categories: Object.keys(NEWS_CATEGORIES).map((id) => ({
        value: id,
        label: categoryLabel(id),
      })),
      severities: NEWS_SEVERITY.map((level, index) => ({
        value: index,
        label: t(level.label),
        color: level.color,
      })),
      items: feed.items
        .filter((r) => passesFilters(r, filters, at))
        .map((r) => feedCardView(r, at)),
      inView: {
        active: inView.active,
        loading: inView.loading,
        error: inView.error ? t(FEED_UNAVAILABLE) : null,
        items: reportsInView(inView.reports, inView.centre, filters, at).map(
          (r) => feedCardView(r, at),
        ),
      },
      selected:
        report && withinNewsWindow(report, at)
          ? feedCardView(report, at)
          : null,
      hasMore: Boolean(feed.nextBefore),
      loading: feed.loading || loading,
      // Read failures are English data; the panel shows them translated.
      error: error || feed.error ? t(error || feed.error) : null,
      lastRunAt,
    };
  }

  const layer = {
    id: NEWS_LAYER_ID,
    name: 'News',
    icon: '◆',
    source: 'GEV news',
    updateInterval: 120_000,

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new cesium.CustomDataSource(NEWS_LAYER_ID);
      outlineSource = new cesium.CustomDataSource(`${NEWS_LAYER_ID}-outlines`);
      dataSource.show = false;
      outlineSource.show = false;
      viewer.dataSources?.add(outlineSource);
      viewer.dataSources?.add(dataSource);
      overlayHost.setVisible(NEWS_OVERLAY_SOURCE_ID, false);
    },
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },
    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      if (dataSource) dataSource.show = true;
      if (outlineSource) outlineSource.show = true;
      overlayHost.setVisible(NEWS_OVERLAY_SOURCE_ID, true);
      registerPickOwner(
        NEWS_LAYER_ID,
        (id) => enabled && String(id).startsWith(NEWS_PICK_PREFIX),
      );
      installSelection();
      // Re-render only when a camera move crosses the detail threshold.
      removeCameraListener =
        viewer?.camera?.moveEnd?.addEventListener?.(() => {
          if (!enabled) return;
          if (detailMode() !== shownDetail) render();
          scheduleInView();
        }) || null;
    },
    disable() {
      enabled = false;
      unavailable = false;
      error = null;
      request?.abort();
      feedRequest?.abort();
      inViewRequest?.abort();
      request = feedRequest = inViewRequest = null;
      clearTimeout(settleTimer);
      settleTimer = null;
      loading = false;
      unregisterPickOwner(NEWS_LAYER_ID);
      removeSelection();
      removeCameraListener?.();
      removeCameraListener = null;
      horizon.stop();
      cullTargets = [];
      clearInterval(pulseTimer);
      pulseTimer = null;
      if (outlineSource) outlineSource.show = false;
      selectedId = null;
      clearSelectedEntityContextForLayer(NEWS_LAYER_ID);
      removeEntityContextsForLayer(NEWS_LAYER_ID);
      contextEntities.clear();
      feed = emptyFeed();
      inView = emptyInView();
      mapReports = [];
      if (dataSource) {
        dataSource.entities.removeAll();
        dataSource.show = false;
      }
      overlayHost.clearSource(NEWS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NEWS_OVERLAY_SOURCE_ID, false);
      requestRender();
      notify();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      // A server without the news routes says so once; no background retries.
      if (unavailable) return true;
      request?.abort();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      loading = true;
      notify();
      try {
        const [index, todays] = await Promise.all([
          source.getHotspots({ signal: controller.signal }),
          source.getFeed(
            {
              hotspot: 'all',
              geo: true,
              today: true,
              events: true,
              relevance: NEWS_RELEVANT,
              limit: NEWS_MAP_LIMIT,
            },
            { signal: controller.signal },
          ),
        ]);
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        hotspots = index.hotspots;
        loadOutlines();
        lastRunAt = index.lastRunAt;
        mapReports = todays.reports.filter((r) => withinNewsWindow(r, now()));
        filters = normalizeFilters({}, hotspots, filters);
        error = null;
        lastUpdate = now();
        render();
        void loadFeed(feed.items.length ? 'head' : 'replace');
        void refreshInView({ force: inView.active });
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        unavailable = cause?.unavailable === true;
        error = cause?.message || FEED_UNAVAILABLE;
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (!enabled || destroyed) return;
      if (params.clear === true) {
        select(null);
        return;
      }
      if (params.filters && typeof params.filters === 'object') {
        const next = normalizeFilters(params.filters, hotspots, filters);
        // The severity floor and the cards change what is shown, not what is read.
        const readKey = ({ hotspot, category, includeMinor }) =>
          `${hotspot}|${category}|${includeMinor}`;
        const reread = readKey(next) !== readKey(filters);
        const minorChanged = next.includeMinor !== filters.includeMinor;
        filters = next;
        if (
          Object.hasOwn(params.filters, 'hotspot') &&
          next.hotspot !== 'all'
        ) {
          const hotspot = hotspots.find((h) => h.id === next.hotspot);
          // The catch-all spans the world: choosing it filters, it does not fly.
          if (hotspot && !hotspot.catchAll) focusRectangle(hotspot.bbox);
        }
        if (reread) feed = emptyFeed();
        render();
        if (reread) void loadFeed('replace');
        if (minorChanged) void refreshInView({ force: true });
        notify();
      }
      if (params.loadMore === true) void loadFeed('append');
      if (typeof params.hotspotId === 'string')
        layer.setParams({ filters: { hotspot: params.hotspotId } });
      if (typeof params.reportId === 'string' && findReport(params.reportId)) {
        select(
          params.reportId,
          Number.isInteger(params.pin) && params.pin > 0 ? params.pin : 0,
        );
        if (params.focus === true) focusReport(selected());
      }
    },
    getRowControls() {
      return {
        chips: [],
        legend: [],
        info: t(
          'Last 24 h from curated hotspots. Each report links to its publisher; places and categories are read from the text automatically and can be wrong. Side labels describe the source, not whether a report is true.',
        ),
        // A ready-to-render view for the News panel (src/ui/newsPanel.js),
        // which takes no layer imports: labels and colours are resolved here.
        feed: feedView(),
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getAnalystRecords() {
      return [];
    },
    getStats() {
      return {
        count: mapReports.filter((r) => r.pins.length && onMap(r)).length,
        lastUpdate,
        loading,
        error,
        ...(unavailable
          ? { status: 'unavailable', sourceUnavailable: true }
          : {}),
        source: 'GEV news',
      };
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      if (viewer && dataSource) viewer.dataSources?.remove(dataSource, true);
      if (viewer && outlineSource)
        viewer.dataSources?.remove(outlineSource, true);
      dataSource = null;
      outlineSource = null;
      outlineParts.clear();
      outlineDisputed.clear();
      viewer = null;
      listener = null;
      runNavigation = null;
    },
  };
  return layer;
}
