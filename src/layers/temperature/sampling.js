import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { formatStop } from './colormap.js';
import { frameLabel } from './dates.js';
import { SAMPLE_MARKER_COLOR } from './policy.js';

export const TEMPERATURE_OVERLAY_SOURCE_ID = 'surface-temperature';

/** Readout marker size; the card's gap and leader clear it. */
const READOUT_MARKER_PX = 11;

/**
 * Overlay card for a sample: the reading (or why there is none) as the title,
 * its qualifiers below.
 * @param {string} title Card title.
 * @param {Array<string>} lines Card body lines.
 * @param {Cesium.Cartesian3} position Readout anchor.
 * @returns {object} World-overlay entry.
 */
export function readoutEntry(title, lines, position) {
  const gapPx = READOUT_MARKER_PX + 8;
  return {
    id: 'readout',
    position,
    variant: 'selected',
    title,
    details: lines,
    accent: SAMPLE_MARKER_COLOR,
    selected: true,
    protected: true,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx,
    leaderOffsetPx: gapPx - 6,
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Click-to-read for the temperature overlay.
 *
 * The overlay is imagery, so there is no entity to pick and nothing on screen
 * says what a colour means at a given spot. This turns a click into a reading
 * of the published product at that point.
 */
export function createSampling({ state: layerState, services, parts, source }) {
  const { governorRequestRender } = services.render;
  const overlay = services.overlay;

  function clearReadout() {
    if (layerState.sampleDataSource?.entities)
      layerState.sampleDataSource.entities.removeAll();
    overlay?.clearSource(TEMPERATURE_OVERLAY_SOURCE_ID);
    layerState.sample = null;
    parts.playback?.refreshPanel();
    governorRequestRender('temperature-sample-clear');
  }

  /**
   * The headline for a sample: the reading itself, or why there is none.
   * @param {object} sample Sample outcome.
   * @returns {string} Card title.
   */
  function readoutTitle(sample) {
    if (sample.outcome === 'measured') return formatStop(sample.stop);
    if (sample.outcome === 'no-value') return 'No clear-sky value';
    if (sample.outcome === 'no-tile') return 'No tile for this point';
    if (sample.outcome === 'outside-projection')
      return 'Outside the projection';
    return 'Sample unavailable';
  }

  /**
   * Context under the headline — never the reading again.
   *
   * Every line qualifies the number rather than repeating it: what quantity it
   * is, how coarse the pixel is, and which month it came from. A reader who
   * takes the figure without those three has the wrong idea of it.
   * @param {object} sample Sample outcome.
   * @returns {Array<string>} Card body lines.
   */
  function readoutLines(sample) {
    const lines = [];
    // The month itself is named on the frame line below; this line only
    // has to say which quantity the number is, because land surface temperature
    // and air temperature differ by tens of degrees in sun.
    if (sample.outcome === 'measured') lines.push('land surface temperature');
    // Cloud, water, or outside the retrieval. Saying so is the whole point: a
    // gap here is not a mild temperature.
    else if (sample.outcome === 'no-value')
      lines.push('cloud, water or unretrieved');
    if (sample.resolutionM)
      lines.push(`~${Math.round(sample.resolutionM / 100) / 10} km pixel`);
    lines.push(frameLabel(layerState.date));
    return lines;
  }

  function renderReadout(sample) {
    if (!layerState.sampleDataSource) return;
    layerState.sampleDataSource.entities.removeAll();
    const position = Cesium.Cartesian3.fromDegrees(
      sample.longitude,
      sample.latitude,
    );
    layerState.sampleDataSource.entities.add({
      id: 'temperature-sample',
      position,
      point: {
        pixelSize: READOUT_MARKER_PX,
        color: Cesium.Color.fromCssColorString(SAMPLE_MARKER_COLOR),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    overlay?.setVisible(TEMPERATURE_OVERLAY_SOURCE_ID, true);
    overlay?.setEntries(
      TEMPERATURE_OVERLAY_SOURCE_ID,
      [readoutEntry(readoutTitle(sample), readoutLines(sample), position)],
      { cohortLimit: 1, collisionCapacity: 1, moving: false },
    );
    parts.playback?.refreshPanel();
    governorRequestRender('temperature-sample');
  }

  /**
   * Read the shown frame at a geographic point and show the result.
   *
   * A newer read supersedes an older one, and a result that lands after the
   * frame changed is dropped: the card must describe the imagery under it.
   * @param {number} latitude Degrees north.
   * @param {number} longitude Degrees east.
   * @returns {Promise<void>} Resolves once the readout settles.
   */
  async function readPoint(latitude, longitude) {
    const date = layerState.date;
    layerState.sampleAbort?.abort();
    const requestAbort = new AbortController();
    layerState.sampleAbort = requestAbort;
    layerState.sampling = true;
    governorRequestRender('temperature-sampling');
    const current = () =>
      !requestAbort.signal.aborted &&
      layerState.sampleAbort === requestAbort &&
      layerState.enabled &&
      layerState.date === date;
    try {
      const sample = await source.sample({
        latitude,
        longitude,
        date,
        signal: requestAbort.signal,
      });
      if (!current()) return;
      // Outcomes without a reading (no tile, outside the projection) carry no
      // coordinates of their own; the card still belongs at the clicked point.
      layerState.sample = { latitude, longitude, ...sample };
      renderReadout(layerState.sample);
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return;
      layerState.sample = { outcome: 'error', latitude, longitude };
      renderReadout(layerState.sample);
    } finally {
      if (layerState.sampleAbort === requestAbort) {
        layerState.sampleAbort = null;
        layerState.sampling = false;
      }
    }
  }

  /**
   * Sample the shown frame under a screen position.
   * @param {Cesium.Cartesian2} position Screen position.
   * @returns {Promise<void>} Resolves once the readout settles.
   */
  async function sampleAt(position) {
    const viewer = layerState.viewer;
    if (!viewer || !layerState.enabled || !layerState.date) return;
    // Read the globe surface, not an entity: a click on another layer's marker
    // is that layer's click, and the ellipsoid pick is what "this point on the
    // ground" means.
    const cartesian = viewer.camera.pickEllipsoid(
      position,
      viewer.scene.globe.ellipsoid,
    );
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    return readPoint(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude),
    );
  }

  /**
   * Re-read the pinned point against the frame now shown, if one is pinned.
   * @returns {Promise<void>|void} Resolves once the readout settles.
   */
  function refreshReadout() {
    const sample = layerState.sample;
    if (!sample || !Number.isFinite(sample.latitude)) return;
    if (!Number.isFinite(sample.longitude)) return;
    return readPoint(sample.latitude, sample.longitude);
  }

  function installInteraction(viewer) {
    if (layerState.clickHandler) return;
    layerState.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    layerState.clickHandler.setInputAction((click) => {
      // A drawing tool or another owner may hold the pointer lease.
      if (!isPointerFree()) return;
      if (!layerState.enabled) return;
      void sampleAt(click.position);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  return {
    installInteraction,
    sampleAt,
    refreshReadout,
    clearReadout,
    readoutTitle,
    readoutLines,
  };
}
