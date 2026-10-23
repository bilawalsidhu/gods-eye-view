import * as Cesium from 'cesium';
import { observationState, ratingsByDay, regionFill } from './model.js';
import {
  MARKER_PX,
  PATH_COLOR,
  PATH_WIDTH_PX,
  REGION_ALPHA,
} from './policy.js';

export const REGION_PICK_PREFIX = 'avalanches:region:';
export const OBSERVATION_PICK_PREFIX = 'avalanches:obs:';

const PATH = Cesium.Color.fromCssColorString(PATH_COLOR);
const SELECTED = Cesium.Color.fromCssColorString('#ffe19a');
const OUTLINE = Cesium.Color.WHITE.withAlpha(0.35);
const MARKER_OUTLINE = Cesium.Color.fromCssColorString('#0a1a2a');

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/**
 * Regions and avalanches as entities whose colour, opacity and visibility
 * are read from per-frame state.
 *
 * Geometry is built once per window and never rebuilt while playing: every
 * animated quantity is a colour, a `show` flag or a point position, which
 * Cesium updates per instance. Rebuilding ground geometry each frame would
 * stall the globe.
 */
export function createRendering({ state: layerState, services }) {
  const { governorRequestRender } = services.render;
  /** regionId -> Cesium.Color for the current playhead. */
  const fills = new Map();
  /** observationId -> observationState for the current playhead. */
  const looks = new Map();

  function clear() {
    layerState.dataSource?.entities.removeAll();
    fills.clear();
    looks.clear();
  }

  function addRegions(window) {
    const entities = layerState.dataSource.entities;
    const ratings = new Map(
      window.regions.map((region) => [
        region.id,
        ratingsByDay(region, window.days),
      ]),
    );
    for (const outline of layerState.outlines ?? []) {
      if (!ratings.has(outline.id)) continue;
      fills.set(outline.id, Cesium.Color.TRANSPARENT.clone());
      outline.polygons.forEach(([outer, ...holes], index) => {
        const id = `${REGION_PICK_PREFIX}${outline.id}:${index}`;
        entities.add({
          id,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              ringPositions(outer),
              holes.map(
                (hole) => new Cesium.PolygonHierarchy(ringPositions(hole)),
              ),
            ),
            material: new Cesium.ColorMaterialProperty(
              new Cesium.CallbackProperty(() => fills.get(outline.id), false),
            ),
          },
        });
        entities.add({
          id: `${id}:outline`,
          polyline: {
            positions: ringPositions(outer),
            width: 1,
            clampToGround: true,
            material: OUTLINE,
          },
        });
      });
    }
    return ratings;
  }

  function addObservations(window) {
    const entities = layerState.dataSource.entities;
    for (const observation of window.observations) {
      const look = () => looks.get(observation.id);
      const selected = () =>
        layerState.selected?.kind === 'observation' &&
        layerState.selected.id === observation.id;
      const size = observation.sizeClass ?? 0;
      const start = Cesium.Cartesian3.fromDegrees(
        observation.start.lon,
        observation.start.lat,
      );
      const id = `${OBSERVATION_PICK_PREFIX}${observation.id}`;
      entities.add({
        id,
        position: start,
        point: {
          pixelSize: new Cesium.CallbackProperty(
            () => MARKER_PX[size] + (selected() ? 4 : 0),
            false,
          ),
          color: new Cesium.CallbackProperty(
            () => (selected() ? SELECTED : PATH).withAlpha(look()?.alpha ?? 0),
            false,
          ),
          outlineColor: MARKER_OUTLINE,
          outlineWidth: 1.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(
            () => Boolean(look()?.visible),
            false,
          ),
        },
      });
      if (!observation.stop) continue;
      const stop = Cesium.Cartesian3.fromDegrees(
        observation.stop.lon,
        observation.stop.lat,
      );
      // The path appears as the front runs down it, then fades with age.
      entities.add({
        id: `${id}:path`,
        polyline: {
          positions: [start, stop],
          width: PATH_WIDTH_PX[size],
          clampToGround: true,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const state = look();
              const alpha =
                (state?.alpha ?? 0) * Math.min(1, (state?.runout ?? 0) * 1.25);
              return (selected() ? SELECTED : PATH).withAlpha(alpha);
            }, false),
          ),
          show: new Cesium.CallbackProperty(
            () => Boolean(look()?.visible),
            false,
          ),
        },
      });
      // The running front: a bright point sliding from release to runout.
      const front = new Cesium.Cartesian3();
      entities.add({
        id: `${id}:front`,
        position: new Cesium.CallbackProperty(
          () => Cesium.Cartesian3.lerp(start, stop, look()?.runout ?? 0, front),
          false,
        ),
        point: {
          pixelSize: MARKER_PX[size] + 2,
          color: Cesium.Color.WHITE,
          outlineColor: PATH.withAlpha(0.6),
          outlineWidth: 4,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(() => {
            const state = look();
            return Boolean(state?.visible && state.runout < 1);
          }, false),
        },
      });
    }
  }

  let ratings = new Map();

  /** Build entities for a newly loaded window. */
  function build(window) {
    if (!layerState.dataSource) return;
    clear();
    ratings = addRegions(window);
    addObservations(window);
    apply(layerState.position);
  }

  /** Recompute every animated quantity for a playhead. */
  function apply(position) {
    const window = layerState.window;
    if (!window) return;
    for (const [id, regionRatings] of ratings) {
      const fill = regionFill(regionRatings, position, REGION_ALPHA);
      const color = fills.get(id);
      if (!color) continue;
      color.red = fill.red;
      color.green = fill.green;
      color.blue = fill.blue;
      color.alpha = fill.alpha;
    }
    const firstDate = window.days[0].date;
    for (const observation of window.observations)
      looks.set(
        observation.id,
        observationState(observation.time, firstDate, position),
      );
    governorRequestRender('avalanches-frame');
  }

  /** @returns {Map<string, Array<number>>} Ratings per region for the window. */
  const getRatings = () => ratings;

  return { build, apply, clear, getRatings };
}
