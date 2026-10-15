import * as Cesium from 'cesium';
import {
  AVALANCHE_OVERLAY_SOURCE_ID,
  cardEntry,
  observationCard,
  regionAnchor,
  regionCard,
} from './cards.js';
import { currentDay, observationState } from './model.js';

const CARD_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/**
 * Keeps the on-map panel and the selected card in step with the playhead.
 *
 * The panel is redrawn every frame (it carries the moving playhead), but the
 * card is republished only when what it says changes — the day on screen or
 * the selection — because the overlay host re-solves placement on every
 * publish.
 */
export function createPresenter({ state: layerState, services, parts }) {
  const overlay = services.overlay ?? null;
  const openExternal = services.openExternal ?? null;
  let publishedKey = null;

  function visibleCount(window) {
    const first = window.days[0].date;
    let count = 0;
    for (const observation of window.observations)
      if (
        observationState(observation.time, first, layerState.position).visible
      )
        count++;
    return count;
  }

  function view() {
    const window = layerState.window;
    const days = window?.days ?? [];
    return {
      days,
      anchor: window?.anchor ?? null,
      position: layerState.position,
      current: days.length ? currentDay(days.length, layerState.position) : 0,
      playing: layerState.playing,
      mode: window?.mode ?? 'live',
      season: layerState.season,
      seasonNumber: window?.season ?? null,
      weekFrom: window?.weekFrom ?? null,
      quiet: layerState.quiet,
      loading: layerState.loading,
      error: layerState.status === 'unavailable' ? layerState.error : null,
      visibleCount: window ? visibleCount(window) : 0,
    };
  }

  function selectedCard(current) {
    const window = layerState.window;
    const selected = layerState.selected;
    if (!window || !selected) return null;
    if (selected.kind === 'region') {
      const region = window.regions.find((entry) => entry.id === selected.id);
      const outline = layerState.outlines?.find(
        (entry) => entry.id === selected.id,
      );
      const ratings = parts.rendering.getRatings().get(selected.id);
      if (!region || !outline || !ratings) return null;
      const anchor = regionAnchor(outline.polygons);
      return cardEntry(
        `region:${region.id}`,
        regionCard(region, ratings, window.days, current),
        Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
      );
    }
    const observation = window.observations.find(
      (entry) => entry.id === selected.id,
    );
    if (!observation) return null;
    const url = observation.url;
    return cardEntry(
      `obs:${observation.id}`,
      observationCard(observation),
      Cesium.Cartesian3.fromDegrees(
        observation.start.lon,
        observation.start.lat,
      ),
      openExternal ? () => (openExternal(url), true) : null,
    );
  }

  function publishCard(current) {
    if (!overlay) return;
    const key = layerState.selected
      ? `${layerState.selected.kind}:${layerState.selected.id}:${current}`
      : null;
    if (key === publishedKey) return;
    publishedKey = key;
    const entry = key ? selectedCard(current) : null;
    if (!entry) {
      overlay.clearSource(AVALANCHE_OVERLAY_SOURCE_ID);
      return;
    }
    overlay.setVisible(AVALANCHE_OVERLAY_SOURCE_ID, true);
    overlay.setEntries(AVALANCHE_OVERLAY_SOURCE_ID, [entry], CARD_OPTIONS);
  }

  return {
    view,
    /** Redraw the panel and, if it changed, the selected card. */
    refresh() {
      if (!layerState.enabled) return;
      const current = view();
      parts.panel?.render(current);
      publishCard(current.current);
    },
    /** Force the card to republish, e.g. after the selection or window changed. */
    invalidateCard() {
      publishedKey = undefined;
    },
    hide() {
      publishedKey = null;
      parts.panel?.hide();
      overlay?.clearSource(AVALANCHE_OVERLAY_SOURCE_ID);
      overlay?.setVisible(AVALANCHE_OVERLAY_SOURCE_ID, false);
    },
  };
}
