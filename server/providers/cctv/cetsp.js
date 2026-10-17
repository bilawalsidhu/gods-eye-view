import fs from 'node:fs';
import path from 'node:path';
import { CETSP_IMAGE_ORIGIN, DEFAULT_CETSP_SOURCE_FILE } from './constants.js';
import { cameraDisplayCode, fallbackHeadingFromId } from './normalize.js';

// CET keeps a ring of numbered stills per camera folder and overwrites one
// every ~14 s, so no index is always newest. Frame 1 is the one CET's own
// page uses for its thumbnails; it is at most one ring cycle (~12 min) old.
const FRAME_PATH = /^\/Cams\/([1-9]\d{0,3})\/1\.jpg$/;

/** One curated row -> one catalog source, or null. Only frame 1 of a numeric
 * CET camera folder can be registered with the image proxy. */
export function cetspCameraToSource(row) {
  if (!row || typeof row !== 'object') return null;
  const { lat, lon } = row;
  // São Paulo municipality, with margin; numbers only, never strings.
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !(lat > -24.05 && lat < -23.3) ||
    !(lon > -46.85 && lon < -46.35)
  )
    return null;
  let folder;
  try {
    const url = new URL(String(row.url));
    folder = FRAME_PATH.exec(url.pathname)?.[1];
    if (
      url.origin !== CETSP_IMAGE_ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      !folder
    )
      return null;
  } catch {
    return null;
  }
  // The id is derived from the folder, so a row cannot pair one camera's name
  // with another camera's frames.
  const id = `cetsp-${folder}`;
  if (row.id !== id) return null;
  // Reconstruct so nothing but the folder number reaches the request.
  const imageUrl = `${CETSP_IMAGE_ORIGIN}/Cams/${folder}/1.jpg`;
  const name = String(row.name || `CET ${folder}`)
    .trim()
    .slice(0, 160);
  return {
    id,
    name,
    city: 'São Paulo',
    cityId: 'sao-paulo',
    provider: 'CET-SP',
    lat,
    lon,
    // CET publishes no pose; use the app's low-confidence prior.
    headingDeg: fallbackHeadingFromId(id),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'cetsp-public',
    credit:
      'CET-SP — Companhia de Engenharia de Tráfego (cameras.cetsp.com.br); periodically updated stills',
    license:
      'Public CET-SP traffic-camera stills; reuse terms unconfirmed. Positions from OpenStreetMap intersections, © OpenStreetMap contributors (ODbL).',
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

/** Read the curated catalog file; no upstream request is made here. */
export function loadCetspSourcesFromCatalog({
  sourceRoot = process.cwd(),
} = {}) {
  const sourceFile =
    process.env.CCTV_CETSP_SOURCES_FILE || DEFAULT_CETSP_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(sourceRoot, sourceFile);
  let rows;
  try {
    if (!fs.existsSync(resolved)) {
      console.warn('[CCTV] CET-SP source file missing:', resolved);
      return [];
    }
    rows = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    console.warn(
      '[CCTV] CET-SP source file read error:',
      error?.message || error,
    );
    return [];
  }
  const cameras = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const camera = cetspCameraToSource(row);
    if (camera && !cameras.has(camera.id)) cameras.set(camera.id, camera);
  }
  console.log('[CCTV] Loaded CET-SP camera sources:', cameras.size);
  return [...cameras.values()];
}
