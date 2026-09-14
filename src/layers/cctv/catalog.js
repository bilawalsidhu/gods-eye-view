import { CAMERA_SEEDS, SOURCE_ENDPOINT } from './policy.js';
import { lookupModelSpec, horizontalFovDeg } from './modelSpecs.js';

/**
 * Applies datasheet enrichment to a camera in place: when it names a known
 * hardware `model`, the manufacturer's horizontal FOV replaces the pose
 * estimate and the spec record is attached for the HUD. Unknown models — the
 * common case — change nothing.
 * @param {Object} camera - Camera being built (mutated).
 * @param {string} [modelName] - Hardware model from a source or seed.
 * @param {(v:number,min:number,max:number)=>number} clamp - Pose clamp helper.
 */
function applyModelEnrichment(camera, modelName, clamp) {
  const spec = modelName ? lookupModelSpec(modelName) : null;
  if (!spec) return;
  const fov = horizontalFovDeg(spec);
  if (fov) {
    camera.fovDeg = clamp(fov, 20, 125);
    camera.fovSource = 'datasheet';
  }
  camera.spec = spec;
}

export function createCatalog({ state: layerState, services, parts, source }) {
  const { CITY_POIS } = services.locations;

  /**
   * Builds the initial camera catalog from CAMERA_SEEDS definitions.
   * Each seed is resolved against its city's POI coordinates, offset, and
   * passed through ensureCameraPose to populate derived fields.
   * @returns {Object[]} Array of fully-initialized camera objects.
   */

  function seedCatalog() {
    const catalog = [];
    for (const seed of CAMERA_SEEDS) {
      const city = CITY_POIS[seed.cityId];
      const poi = city?.pois?.[seed.poiIndex];
      if (!city || !poi) continue;
      const { latOffset, lonOffset } = parts.model.offsetDegrees(
        poi.lat,
        seed.offsetNorthM || 0,
        seed.offsetEastM || 0,
      );
      const camera = {
        id: seed.id,
        name: seed.label,
        cityId: seed.cityId,
        city: city.name,
        provider: 'OSM Camera Grid',
        sourceKind: 'seed',
        feedType: 'image',
        feedConfigured: false,
        headingConfidence: 'medium',
        lat: poi.lat + latOffset,
        lon: poi.lon + lonOffset,
        headingDeg: parts.model.normalizeHeading(
          seed.headingDeg ?? poi.heading ?? 0,
        ),
        fovDeg: parts.model.clamp(seed.fovDeg ?? 70, 20, 120),
        rangeM: parts.model.clamp(seed.rangeM ?? 700, 260, 1800),
        mountHeightM: parts.model.clamp(seed.elevationM ?? 22, 8, 80),
        groundElevationM: Number(city.groundElevation) || 0,
        absoluteHeightM:
          (Number(city.groundElevation) || 0) +
          parts.model.clamp(seed.elevationM ?? 22, 8, 80),
        pitchDeg: parts.model.clamp(seed.pitchDeg ?? -17, -40, -4),
      };
      applyModelEnrichment(camera, seed.model, parts.model.clamp);
      parts.model.ensureCameraPose(camera);
      catalog.push(camera);
    }
    return catalog;
  }

  /**
   * Looks up a city ID from CITY_POIS by exact or partial name match.
   * @param {string} cityName
   * @returns {string|null} Matching city ID or null.
   */

  function cityIdByName(cityName) {
    const probe = String(cityName || '')
      .trim()
      .toLowerCase();
    if (!probe) return null;
    for (const [cityId, city] of Object.entries(CITY_POIS)) {
      if (city.name.toLowerCase() === probe) return cityId;
    }
    for (const [cityId, city] of Object.entries(CITY_POIS)) {
      if (
        city.name.toLowerCase().includes(probe) ||
        probe.includes(city.name.toLowerCase())
      )
        return cityId;
    }
    return null;
  }

  /**
   * Fetches configured camera sources from the backend.
   * @returns {Promise<Object[]>} Array of raw source objects, or empty on failure.
   */

  async function loadCameraSources() {
    try {
      const signal = layerState._sourceAbort?.signal;
      const data = await source.getCatalog({ signal });
      signal?.throwIfAborted();
      if (!Array.isArray(data?.sources)) return [];
      return data.sources;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return [];
    }
  }

  /**
   * Merges raw backend sources with seed data to produce the final camera catalog.
   * Seeds provide fallback values for heading, FOV, range, etc. when not specified
   * by the source. Each camera is passed through ensureCameraPose.
   * @param {Object[]} rawSources - Raw source objects from the backend.
   * @returns {Object[]} Array of fully-initialized camera objects.
   */

  function buildCatalogFromSources(rawSources) {
    const sources = Array.isArray(rawSources) ? rawSources : [];
    if (!sources.length) return [];

    const seeded = seedCatalog();
    const seedById = new Map(seeded.map((camera) => [camera.id, camera]));

    const catalog = [];
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const id = String(source.id || '').trim();
      if (!id) continue;
      const seed = seedById.get(id);
      const cityId =
        String(source.cityId || '').trim() ||
        cityIdByName(source.city) ||
        seed?.cityId ||
        '';
      const city = cityId && CITY_POIS[cityId] ? CITY_POIS[cityId] : null;

      const lat = parts.model.safeNumber(source.lat, seed?.lat ?? NaN);
      const lon = parts.model.safeNumber(source.lon, seed?.lon ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const sourceHeading = parts.model.safeNumber(source.headingDeg, NaN);
      const headingDeg = parts.model.normalizeHeading(
        Number.isFinite(sourceHeading)
          ? sourceHeading
          : (seed?.headingDeg ?? parts.model.headingFromId(id)),
      );
      const fovDeg = parts.model.clamp(
        parts.model.safeNumber(source.fovDeg, seed?.fovDeg ?? 74),
        20,
        125,
      );
      // Same floor as the pose model (model.js): the packs' 145/210 m ranges
      // are intentional, and inflating them to 220 m pushed the monitor
      // plane's far edge into higher ground (owner field test 2026-09-13).
      const rangeM = parts.model.clamp(
        parts.model.safeNumber(source.rangeM, seed?.rangeM ?? 700),
        120,
        2200,
      );
      const mountHeightM = parts.model.clamp(
        parts.model.safeNumber(source.mountHeightM, seed?.mountHeightM ?? 24),
        6,
        120,
      );
      const pitchDeg = parts.model.clamp(
        parts.model.safeNumber(source.pitchDeg, seed?.pitchDeg ?? -17),
        -55,
        -2,
      );
      const groundElevationM = parts.model.safeNumber(
        source.groundElevationM,
        city?.groundElevation ?? seed?.groundElevationM ?? 0,
      );
      const feedType = parts.model.normalizeFeedType(
        source.feedType || source.type || 'image',
      );
      const headingConfidence = String(
        source.headingConfidence || (seed ? 'high' : 'low'),
      ).toLowerCase();
      // CAL badge input (design §3b passthrough): hand-authored file/env source
      // entries may carry poseSource:'curated'. Austin Open Data rows never set
      // this — they stay RAW PRIOR until a human manually calibrates them.
      const poseSource =
        source.poseSource === 'curated' ? 'curated' : seed?.poseSource || null;

      const camera = {
        id,
        name: String(source.name || seed?.name || id),
        cityId,
        city: String(source.city || city?.name || seed?.city || 'Global'),
        provider: String(
          source.provider || seed?.provider || 'Configured CCTV Source',
        ),
        sourceKind: String(
          source.sourceKind ||
            source.kind ||
            (source.url ? 'configured' : 'seed'),
        ).toLowerCase(),
        feedType,
        feedConfigured: typeof source.url === 'string' && !!source.url.trim(),
        lat,
        lon,
        headingDeg,
        headingConfidence,
        fovDeg,
        rangeM,
        mountHeightM,
        groundElevationM,
        absoluteHeightM: groundElevationM + mountHeightM,
        pitchDeg,
        license: String(source.license || source.licenseNote || ''),
        credit: String(source.credit || ''),
        code: String(source.code || ''),
        // Shipped precompute (see server/providers/cctv/groundHeights.js).
        groundHeights:
          source.groundHeights && typeof source.groundHeights === 'object'
            ? source.groundHeights
            : null,
        poseSource,
      };
      applyModelEnrichment(
        camera,
        source.model || seed?.model,
        parts.model.clamp,
      );
      parts.model.ensureCameraPose(camera);
      catalog.push(camera);
    }

    return catalog;
  }
  return {
    seedCatalog,
    cityIdByName,
    loadCameraSources,
    buildCatalogFromSources,
  };
}
