import {
  captureViewportImage,
  computeDownscale,
  isNearlyBlackFrame,
} from './realtimeViewport.js';

/**
 * Screenshot for visual questions on the local path. Renders one Cesium frame
 * synchronously and reads the canvas in the same tick, so it works without
 * preserveDrawingBuffer and does not depend on the render loop timing (the
 * upstream helper waits for postRender, which headless and throttled tabs
 * can miss).
 */
export async function captureLocalViewport({
  viewer = globalThis.window?.__godsEyeView?.viewer,
  maxPixels = 1200 * 900,
  quality = 0.74,
  documentRef = globalThis.document,
  upstream = captureViewportImage,
} = {}) {
  // The upstream helper waits for a fresh postRender; when that times out
  // (throttled or headless tabs) fall back to an explicit synchronous render.
  try {
    const fresh = await upstream();
    if (fresh) return fresh;
  } catch {
    /* fall through */
  }
  const canvas = viewer?.scene?.canvas || viewer?.canvas;
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    viewer.scene.requestRender?.();
    viewer.scene.render?.();
  } catch {
    /* A failed explicit render still leaves the last frame in place. */
  }
  const size = computeDownscale(canvas.width, canvas.height, maxPixels);
  const width = Math.max(1, Math.round(size?.width ?? canvas.width));
  const height = Math.max(1, Math.round(size?.height ?? canvas.height));
  const scratch = documentRef.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, width, height);
  if (isNearlyBlackFrame(ctx, width, height)) return null;
  return scratch.toDataURL('image/jpeg', quality);
}

/** ICAO airline designators for the carriers most often seen in the feed. */
export const AIRLINE_PREFIXES = Object.freeze({
  AAL: 'American Airlines',
  DAL: 'Delta Air Lines',
  UAL: 'United Airlines',
  SWA: 'Southwest Airlines',
  JBU: 'JetBlue',
  ASA: 'Alaska Airlines',
  NKS: 'Spirit Airlines',
  FFT: 'Frontier Airlines',
  SKW: 'SkyWest',
  ENY: 'Envoy Air',
  RPA: 'Republic Airways',
  EDV: 'Endeavor Air',
  PDT: 'Piedmont Airlines',
  JIA: 'PSA Airlines',
  QXE: 'Horizon Air',
  ACA: 'Air Canada',
  WJA: 'WestJet',
  BAW: 'British Airways',
  VIR: 'Virgin Atlantic',
  EZY: 'easyJet',
  RYR: 'Ryanair',
  DLH: 'Lufthansa',
  AFR: 'Air France',
  KLM: 'KLM',
  IBE: 'Iberia',
  VLG: 'Vueling',
  SAS: 'SAS',
  FIN: 'Finnair',
  AUA: 'Austrian',
  SWR: 'Swiss',
  THY: 'Turkish Airlines',
  UAE: 'Emirates',
  QTR: 'Qatar Airways',
  ETD: 'Etihad',
  SIA: 'Singapore Airlines',
  CPA: 'Cathay Pacific',
  JAL: 'Japan Airlines',
  ANA: 'All Nippon Airways',
  KAL: 'Korean Air',
  AAR: 'Asiana',
  CCA: 'Air China',
  CES: 'China Eastern',
  CSN: 'China Southern',
  QFA: 'Qantas',
  ANZ: 'Air New Zealand',
  LAN: 'LATAM',
  AMX: 'Aeromexico',
  VOI: 'Volaris',
  FDX: 'FedEx Express',
  UPS: 'UPS Airlines',
  GTI: 'Atlas Air',
  ABX: 'ABX Air',
  CKS: 'Kalitta Air',
  RCH: 'US Air Force (REACH)',
});

export function airlineFromCallsign(callsign) {
  const prefix = String(callsign || '')
    .trim()
    .toUpperCase()
    .slice(0, 3);
  return /^[A-Z]{3}$/.test(prefix) ? AIRLINE_PREFIXES[prefix] || null : null;
}
