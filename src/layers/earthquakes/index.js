import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';
import { worldClock } from '../../time/worldClock.js';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  depthAccent,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
  earthquakeCoverage,
  earthquakeMarkLabel,
  earthquakeMagnitudeTitle,
  earthquakeZoomLabel,
  earthquakeDiscRadiusM,
  describeEarthquake,
} from './model.js';
export * from './model.js';
export { createUsgsEarthquakeSource } from './source.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/**
 * The draw sets the discs are drawn in start with this; each layer has its
 * own (`earthquakes:1`, …), so several can share a renderer. Picks name it
 * as `Hit.set`.
 */
export const EARTHQUAKE_DISC_SET_ID = 'earthquakes';
export const EARTHQUAKES_LAYER_ID = 'earthquakes';
/** The overlay source the clicked quake's detail card is shown in. */
export const EARTHQUAKE_CARD_SOURCE_ID = 'earthquake-card';
/** A disc's item id is this prefix and the event's stable id. */
const PICK_PREFIX = 'earthquake:';
/** The selected quake's flat fill, faint under the painted gradient. */
const SELECTED_DISC_ALPHA = 0.04;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
let instances = 0;

/**
 * Own one earthquake display and its refresh lifecycle.
 *
 * The discs are one renderer draw set (`drawOf(viewer)`), made at `init`.
 * Given a Cesium viewer with no renderer bound, the
 * caller loads the package's `./render/cesium/unbound` export first.
 *
 * Clicking a disc shows that quake's detail card and selects it in the
 * shared context. The application gives the click and selection services;
 * without `input` and `picking` the discs are drawn but take no clicks.
 * @param {object} options
 * @param {object} options.source Snapshot source.
 * @param {object} options.overlayHost World-overlay host (`hitTest` lets
 *   the card be clicked).
 * @param {(viewer: object) => {onClick: Function}} [options.input] The
 *   viewer's click dispatcher.
 * @param {{resolvePickId: Function, isOwnedByOtherLayer: Function}} [options.picking]
 * @param {{registerEntityContext: Function, selectEntityContext: Function,
 *   clearSelectedEntityContextForLayer: Function,
 *   getContextStore: Function}} [options.context] Shared selection store.
 * @param {{isPointerFree: () => boolean}} [options.pointer]
 * @param {(url: string) => void} [options.openExternal]
 * @param {{requestWorldFocus: (detail: object) => boolean}} [options.focus]
 *   The camera transfer a clicked magnitude label asks for.
 * @param {{show: (target: {id: string, lon: number, lat: number,
 *   radiusM: number, color: string}) => void, hide: () => void}} [options.ripples]
 *   The selected quake's animated contour rings.
 * @param {object} [options.text] Card formatters (see describeEarthquake).
 */
export function createEarthquakesLayer({
  source,
  overlayHost,
  input = null,
  picking = null,
  context = null,
  pointer = null,
  openExternal = null,
  focus = null,
  ripples = null,
  text = undefined,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _discs = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  // What the discs were drawn from, so analyst reads come from the layer, not the
  // drawing, and the timeline reads its marks ({ mag, time, place, usgsId }).
  let _events = [];
  let _uncover = null;
  // The marks last told to the clock, so a refresh with the same strong
  // quakes does not tell it again.
  let _marksKey = null;
  const coverage = () => (_enabled ? earthquakeCoverage(_events) : null);
  const coverageChanged = () => {
    const covered = coverage();
    const key = covered ? JSON.stringify(covered.marks) : null;
    if (key === _marksKey) return;
    _marksKey = key;
    worldClock.coverageChanged();
  };
  // The drawn events by stable id, for clicks; the selected one's id, card
  // and the context record it was published as.
  let _eventById = new Map();
  let _selectedId = null;
  let _selectedCardId = null;
  let _selectedLink = null;
  let _contextId = null;
  let _clickHandler = null;
  const canSelect = () => Boolean(input && picking);
  // The disc whose flat fill is faded while the painter draws its gradient.
  let _fadedDiscId = null;

  /**
   * A quake's disc: filled on the ground, with static axes (re-tessellating
   * clamped ground geometry every frame is what once cost 30 fps). No
   * outline: clamped to the ground, Cesium never drew one. A selected
   * quake's disc is all but clear: the ripples painter fills it with a
   * gradient instead, and the faint fill keeps it pickable.
   */
  function discItem(event, faded = false) {
    const radius = earthquakeDiscRadiusM(event.mag);
    const [r, g, b] = depthColor(event.depthKm || 0);
    const fillAlpha = faded
      ? SELECTED_DISC_ALPHA
      : event.mag >= 5.0
        ? 0.4
        : 0.3;
    return {
      id: `${PICK_PREFIX}${event.stableId}`,
      geometry: {
        kind: 'ellipse',
        center: { lon: event.lon, lat: event.lat },
        semiMajor: radius,
        semiMinor: radius,
      },
      fill: [r, g, b, fillAlpha],
      height: 'clampGround',
      clampTo: 'both',
    };
  }

  /** Fade one disc's flat fill (and restore the one faded before). */
  function fadeDisc(stableId) {
    if (!ripples || !_discs || _fadedDiscId === stableId) return;
    const changed = [];
    const before = _eventById.get(_fadedDiscId);
    if (before) changed.push(discItem(before, false));
    const next = _eventById.get(stableId);
    if (next) changed.push(discItem(next, true));
    _fadedDiscId = next ? stableId : null;
    if (changed.length) _discs.upsert(changed);
  }

  /** The drawn event a pick id names, or null. */
  function eventOfPickId(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    return _eventById.get(pickId.slice(PICK_PREFIX.length)) ?? null;
  }

  /** The drawn event a click's draw hit is on: an item of this layer's set. */
  function pickedEvent(hit) {
    if (!hit || hit.surface || !_discs || hit.set !== _discs.id) return null;
    return eventOfPickId(hit.id);
  }

  /**
   * Show the selected quake's card, context and contours. `user`: a click or
   * a label's activation, which claims the shared selection and runs the
   * contours again; a feed refresh only brings them up to date, so it never
   * takes back a selection made since, nor restarts the animation.
   */
  function publishCard({ user = false } = {}) {
    const event = _selectedId ? _eventById.get(_selectedId) : null;
    if (!_enabled || !event) {
      clearSelection();
      return;
    }
    const { title, details, link, accessibilityLabel } = describeEarthquake(
      event,
      text,
    );
    _selectedLink = link && openExternal ? link : null;
    const card = {
      id: `earthquake-card:${event.stableId}`,
      selected: true,
      // Always hit-testable (the host only hit-tests interactive entries),
      // so a click on a card with no link keeps it rather than falling
      // through to the ground under it and clearing the selection.
      interactive: true,
      title,
      details,
      accent: depthAccent(event.depthKm || 0),
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      stateless: true,
      horizonCull: true,
      position: fromDegrees(event.lon, event.lat),
    };
    if (_selectedLink) {
      const target = _selectedLink;
      card.accessibilityLabel = accessibilityLabel;
      card.activate = () => {
        openExternal(target);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      EARTHQUAKE_CARD_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
    overlayHost.setVisible(EARTHQUAKE_CARD_SOURCE_ID, true);
    publishContext(event, user);
    fadeDisc(event.stableId);
    ripples?.show?.(
      {
        id: event.stableId,
        lon: event.lon,
        lat: event.lat,
        radiusM: earthquakeDiscRadiusM(event.mag),
        color: depthAccent(event.depthKm || 0),
      },
      { restart: user },
    );
  }

  /**
   * Select the event in the shared context store, so "what's selected"
   * (voice, the Cockpit) answers with it, as a clicked fire does.
   */
  function publishContext(event, select) {
    if (!context) return;
    const id = `${PICK_PREFIX}${event.stableId}`;
    try {
      if (_contextId && _contextId !== id)
        context.getContextStore().entities.delete(_contextId);
      const carrier = { show: true };
      context.registerEntityContext(carrier, {
        id,
        layerId: EARTHQUAKES_LAYER_ID,
        layerName: layer.name,
        source: 'USGS',
        // Hidden with the layer: the context store reads its `show`.
        dataSource: _discs,
        targetPosition: fromDegrees(event.lon, event.lat),
        // i18n-ignore: English entity label, as the analyst records are
        label: `Earthquake · ${earthquakeMarkLabel(event)}`,
        latitude: event.lat,
        longitude: event.lon,
        properties: {
          magnitude: event.mag,
          depthKm: event.depthKm ?? null,
          place: event.place ?? null,
          time: Number.isFinite(event.time)
            ? new Date(event.time).toISOString()
            : null,
          usgsId: event.usgsId ?? null,
        },
      });
      _contextId = id;
      if (select) context.selectEntityContext(carrier);
    } catch {
      // No context store (no window): the card still shows.
    }
  }

  function clearContext() {
    if (!context || !_contextId) return;
    try {
      context.clearSelectedEntityContextForLayer(EARTHQUAKES_LAYER_ID);
      context.getContextStore().entities.delete(_contextId);
    } catch {
      // store unavailable: nothing to clean
    }
    _contextId = null;
  }

  function clearSelection() {
    const had = _selectedId || _selectedCardId;
    _selectedId = null;
    _selectedCardId = null;
    _selectedLink = null;
    clearContext();
    ripples?.hide?.();
    fadeDisc(null);
    if (had)
      overlayHost.setEntries(EARTHQUAKE_CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry, like drone
    // airspace and fire perimeters: siblings yield to owned picks before
    // their own card hit-tests and treat an owned pick as not empty space,
    // so claiming these large discs would make their cards inert and their
    // selections stick anywhere over a quake. Unowned, a disc reads as
    // empty space to them; this handler finds its own discs by draw set.
    // A viewer with no renderer input bound takes no clicks.
    let clicks = null;
    try {
      clicks = input(_viewer) ?? null;
    } catch {
      clicks = null;
    }
    if (!clicks) return;
    _clickHandler = clicks.onClick((click) => {
      if (!_enabled || (pointer && !pointer.isPointerFree())) return;
      const at = click.screenPosition;
      // Another layer's card or label painted on top (a fire's card over a
      // quake disc) is that layer's click: the disc under it is background.
      const topEntry = overlayHost.hitTest?.(at?.x, at?.y);
      if (
        topEntry &&
        topEntry.sourceId !== EARTHQUAKE_CARD_SOURCE_ID &&
        topEntry.sourceId !== EARTHQUAKE_OVERLAY_SOURCE_ID
      )
        return;
      // Another layer's pick (an aircraft, a camera) is not this layer's,
      // even under this layer's card or a magnitude label: that layer acts
      // on the click itself, and this card stays. Checked before the card
      // and the labels, as the fire layer does.
      const hit = click.hit;
      const pickId = picking.resolvePickId(hit);
      if (pickId && picking.isOwnedByOtherLayer(EARTHQUAKES_LAYER_ID, pickId))
        return;
      const cardHit = overlayHost.hitTest?.(at?.x, at?.y, {
        sourceId: EARTHQUAKE_CARD_SOURCE_ID,
      });
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink) openExternal(_selectedLink);
        return;
      }
      // A magnitude label is what a far view (the whole globe) can click:
      // it selects the quake and flies to it.
      const labelHit = overlayHost.hitTest?.(at?.x, at?.y, {
        sourceId: EARTHQUAKE_OVERLAY_SOURCE_ID,
      });
      if (labelHit && _eventById.has(labelHit.entryId)) {
        selectAndFocus(labelHit.entryId);
        return;
      }
      const event = pickedEvent(hit);
      if (event) {
        _selectedId = event.stableId;
        publishCard({ user: true });
        return;
      }
      clearSelection();
    });
  }

  /** Select a drawn quake, show its card, and ask the camera to go there. */
  function selectAndFocus(stableId) {
    const event = _eventById.get(stableId);
    if (!_enabled || !event) return false;
    _selectedId = stableId;
    publishCard({ user: true });
    focus?.requestWorldFocus?.({
      kind: 'earthquake',
      id: `${PICK_PREFIX}${stableId}`,
      label: earthquakeMagnitudeTitle(event.mag),
      position: fromDegrees(event.lon, event.lat),
    });
    return true;
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
  }

  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Earthquake layer is already initialized');
      _discs = drawOf(viewer).shapes({
        id: `${EARTHQUAKE_DISC_SET_ID}:${++instances}`,
        show: false,
      });
      _viewer = viewer;
      // While on, the strong quakes are marks on the world clock's timeline.
      // Registered once; off, the layer has no time to show.
      _marksKey = null;
      _uncover = worldClock.register({ id: 'earthquakes', coverage });
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Earthquakes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      if (_discs) _discs.show = true;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      coverageChanged();
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_discs) _discs.show = false;
      removeClickHandler();
      clearSelection();
      overlayHost.clearSource(EARTHQUAKE_CARD_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_CARD_SOURCE_ID, false);
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      coverageChanged();
    },

    async update(viewer) {
      if (!_enabled || !_discs) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextDiscs = [];
        const nextEvents = [];
        let count = 0;
        const overlayEntries = [];

        for (const {
          stableId,
          usgsId,
          lon,
          lat,
          depthKm,
          mag,
          place,
          time,
        } of rows) {
          count++;
          const position = fromDegrees(lon, lat);
          const event = {
            stableId: String(stableId),
            usgsId,
            mag,
            place,
            time,
            depthKm,
            lon,
            lat,
          };
          nextEvents.push(event);
          nextDiscs.push(
            discItem(event, Boolean(ripples) && event.stableId === _selectedId),
          );
          const label = createEarthquakeOverlayEntry({
            id: String(stableId),
            position,
            magnitude: mag,
            accent: depthAccent(depthKm || 0),
          });
          if (canSelect()) {
            const id = String(stableId);
            label.interactive = true;
            label.accessibilityLabel = earthquakeZoomLabel(
              { mag, place },
              text,
            );
            label.activate = () => selectAndFocus(id);
          }
          overlayEntries.push(label);
        }

        // Bigger quakes first, so a small quake inside a big one's disc is
        // drawn, and picked, on top of it.
        nextDiscs.sort((a, b) => b.geometry.semiMajor - a.geometry.semiMajor);
        _discs.set(nextDiscs);
        _events = nextEvents;
        _eventById = new Map(
          nextEvents.map((event) => [event.stableId, event]),
        );
        _fadedDiscId =
          ripples && _eventById.has(_selectedId) ? _selectedId : null;
        // A selected quake still in the feed keeps its card, refreshed; one
        // that left the 24 h window loses it.
        if (_selectedId) publishCard();
        coverageChanged();
        if (_enabled) {
          overlayHost.setEntries(
            EARTHQUAKE_OVERLAY_SOURCE_ID,
            selectEarthquakeOverlayCohort(overlayEntries),
            {
              cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Earthquakes] Updated: ${_count} events (M2.5+)`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Earthquakes] Fetch error:', e);
        _lastError = e?.message || msg('Earthquake source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      ripples?.dispose?.();
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EARTHQUAKE_CARD_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_CARD_SOURCE_ID, false);
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      _discs?.dispose();
      _discs = null;
      _events = [];
      _eventById = new Map();
      _uncover?.();
      _uncover = null;
      _marksKey = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_discs || !_enabled || !_events.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _events.slice(0, limit).map((event, index) =>
        mapAnalystRecord(
          {
            id: event.usgsId ?? null,
            mag: event.mag,
            place: event.place,
            time: event.time,
            depth: event.depthKm,
            lat: event.lat,
            lon: event.lon,
          },
          index,
        ),
      );
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
