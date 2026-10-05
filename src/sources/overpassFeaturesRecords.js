import { stitchRing } from './featureGeometry.js';

function elementCoordinates(element) {
  if (Array.isArray(element.geometry)) {
    return element.geometry.filter(
      (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
    );
  }
  if (!Array.isArray(element.members)) return [];
  // For a multipolygon relation the boundary is split across several outer
  // ways (the Presidio has 8), so chain them into one ring by matching
  // endpoints rather than taking a single segment.
  const outerWays = element.members
    .filter((m) => (m.role === 'outer' || !m.role) && Array.isArray(m.geometry))
    .map((m) =>
      m.geometry.filter(
        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
      ),
    )
    .filter((w) => w.length >= 2);
  return stitchRing(outerWays);
}

function buildingHeightFromTags(tags) {
  const explicit = parseMeters(tags.height || tags['building:height']);
  if (explicit) return explicit;
  const levels = Number.parseFloat(tags['building:levels']);
  const roof = parseMeters(tags['roof:height']) || 0;
  if (Number.isFinite(levels) && levels > 0) return levels * 3.3 + roof;
  return null;
}

function parseMeters(value) {
  if (value == null) return 0;
  const n = Number.parseFloat(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return /\b(ft|feet|foot)\b/i.test(String(value)) ? n * 0.3048 : n;
}

/** Normalize backend tags and member geometry before feature selection. */
export function normalizeOverpassFeatures(elements, { focus = false } = {}) {
  return elements.map((element) => {
    const tags = element.tags || {};
    const coordinates =
      focus && !Array.isArray(element.geometry)
        ? (Array.isArray(element.members) ? element.members : []).flatMap(
            (member) =>
              (Array.isArray(member.geometry) ? member.geometry : []).filter(
                (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
              ),
          )
        : elementCoordinates(element);
    return {
      id: element.id,
      category: element.type === 'area' ? 'administrative' : 'feature',
      names: {
        primary: tags.name,
        english: tags['name:en'],
        official: tags.official_name,
        alternate: tags.alt_name,
        short: tags.short_name,
      },
      level: Number(tags.admin_level) || 99,
      building: Boolean(tags.building),
      heightM: buildingHeightFromTags(tags),
      coordinates,
      center: element.center || null,
      point: Number.isFinite(element.lat)
        ? { lat: element.lat, lon: element.lon }
        : element.center
          ? { lat: element.center.lat, lon: element.center.lon }
          : null,
      provenance: { type: element.type, id: element.id },
    };
  });
}
