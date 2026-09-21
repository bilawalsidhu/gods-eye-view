import {
  TAIWAN_FREEWAY_CCTV_URL,
  DEFAULT_TAIWAN_FREEWAY_MAX_SOURCES,
  TAIWAN_FREEWAY_MAX_CATALOG_BYTES,
  TDX_TOKEN_URL,
  TDX_API_ORIGIN,
  DEFAULT_TDX_CCTV_CITIES,
  DEFAULT_TDX_MAX_SOURCES,
  TAIWAN_GROUND_ELEVATION_M,
  TAIWAN_ANCHORS,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';
import {
  toFiniteNumber,
  fallbackHeadingFromId,
  prioritizeSources,
} from './normalize.js';
import { haversineKm } from '../common/geo.js';
import { readCappedResponseText } from '../common/http.js';

/**
 * Taiwan CCTV packs.
 *
 *  - Freeway Bureau (交通部高速公路局): keyless MOTC-standard XML catalog; every
 *    camera is a live MJPEG stream on *.freeway.gov.tw.
 *  - TDX (運輸資料流通服務): provincial highways (公路局) and city cameras,
 *    same MOTC record shape as JSON. Needs TDX_CLIENT_ID / TDX_CLIENT_SECRET;
 *    skipped silently without them.
 *
 * Both register `feedType: 'mjpeg'` for streams, so the proxy pipes the live
 * multipart body to the active camera and cuts single JPEG snapshots from it
 * for ambient cards.
 */

const DIRECTION_HEADING = Object.freeze({ N: 0, E: 90, S: 180, W: 270 });
const DIRECTION_ZH = Object.freeze({
  N: '北向',
  E: '東向',
  S: '南向',
  W: '西向',
});

/** Taiwan main island + Penghu/Kinmen/Matsu bounding box. */
export function isLikelyTaiwanCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 21.8 &&
    lat <= 26.5 &&
    lon >= 118.1 &&
    lon <= 122.1
  );
}

function decodeXmlText(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function xmlField(body, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return match ? decodeXmlText(match[1]) : '';
}

/**
 * Parse the MOTC-standard CCTV XML (<CCTVList><CCTVs><CCTV>…) into plain
 * records using the same field names the TDX JSON API returns.
 *
 * @param {string} xml
 * @returns {Array<object>}
 */
export function parseMotcCctvXml(xml) {
  const out = [];
  const blockRe = /<CCTV>([\s\S]*?)<\/CCTV>/g;
  let match;
  while ((match = blockRe.exec(String(xml || ''))) !== null) {
    const body = match[1];
    const section = /<RoadSection>([\s\S]*?)<\/RoadSection>/.exec(body)?.[1];
    out.push({
      CCTVID: xmlField(body, 'CCTVID'),
      VideoStreamURL: xmlField(body, 'VideoStreamURL'),
      VideoImageURL: xmlField(body, 'VideoImageURL'),
      PositionLat: xmlField(body, 'PositionLat'),
      PositionLon: xmlField(body, 'PositionLon'),
      RoadID: xmlField(body, 'RoadID'),
      RoadName: xmlField(body, 'RoadName'),
      RoadDirection: xmlField(body, 'RoadDirection'),
      RoadSection: section
        ? { Start: xmlField(section, 'Start'), End: xmlField(section, 'End') }
        : null,
      LocationMile: xmlField(body, 'LocationMile'),
      SurveillanceDescription: xmlField(body, 'SurveillanceDescription'),
    });
  }
  return out;
}

/** "12K+345" → 12.345 km; NaN when absent. */
export function parseLocationMileKm(value) {
  const match = /(\d+(?:\.\d+)?)\s*K\s*\+?\s*(\d+(?:\.\d+)?)?/i.exec(
    String(value || ''),
  );
  if (!match) return NaN;
  return Number(match[1]) + (match[2] ? Number(match[2]) / 1000 : 0);
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.cos((lon2 - lon1) * toRad);
  return (((Math.atan2(y, x) / toRad) % 360) + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Estimate each camera's heading from the road geometry: cameras on one road
 * and carriageway are ordered by mileage, the bearing to the nearest distinct
 * neighbour gives the road axis, and the published travel direction (N/E/S/W)
 * picks which way along that axis the camera looks. Falls back to the bare
 * cardinal when a camera has no usable neighbour.
 *
 * @param {Array<{key:string, lat:number, lon:number, mileKm:number, direction:string}>} items
 * @returns {Map<object,{headingDeg:number, confidence:string}>}
 */
export function deriveRoadHeadings(items) {
  const result = new Map();
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.key) || [];
    group.push(item);
    groups.set(item.key, group);
  }
  for (const group of groups.values()) {
    const ordered = group
      .filter((item) => Number.isFinite(item.mileKm))
      .sort((a, b) => a.mileKm - b.mileKm);
    // Travel sense is decided once per carriageway from its end-to-end bearing:
    // a single camera's local axis can sit perpendicular to the published
    // cardinal (a curve), which would make a per-camera choice a coin flip.
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const groupCardinal = DIRECTION_HEADING[group[0]?.direction];
    let increasingMileageForward = null;
    if (
      first &&
      last &&
      Number.isFinite(groupCardinal) &&
      haversineKm(first.lat, first.lon, last.lat, last.lon) >= 0.5
    ) {
      const overall = bearingDeg(first.lat, first.lon, last.lat, last.lon);
      increasingMileageForward =
        angleDiff(overall, groupCardinal) <=
        angleDiff((overall + 180) % 360, groupCardinal);
    }
    for (const item of group) {
      const cardinal = DIRECTION_HEADING[item.direction];
      const index = ordered.indexOf(item);
      let axis = NaN;
      if (index >= 0) {
        // Road axis (increasing mileage) = chord across up to three mileage
        // neighbours on each side. Published positions are noisy — a camera
        // can sit hundreds of metres from its mileage slot — and a wide chord
        // keeps one outlier from flipping the axis.
        for (let k = 3; k >= 1 && !Number.isFinite(axis); k--) {
          const a = ordered[Math.max(0, index - k)];
          const b = ordered[Math.min(ordered.length - 1, index + k)];
          if (a === b) continue;
          const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
          if (km < 0.15 || km > 6) continue;
          axis = bearingDeg(a.lat, a.lon, b.lat, b.lon);
        }
      }
      if (Number.isFinite(axis) && increasingMileageForward !== null) {
        result.set(item, {
          headingDeg: increasingMileageForward ? axis : (axis + 180) % 360,
          confidence: 'medium',
        });
      } else if (Number.isFinite(axis) && Number.isFinite(cardinal)) {
        const reverse = (axis + 180) % 360;
        const headingDeg =
          angleDiff(axis, cardinal) <= angleDiff(reverse, cardinal)
            ? axis
            : reverse;
        result.set(item, { headingDeg, confidence: 'medium' });
      } else if (Number.isFinite(cardinal)) {
        result.set(item, { headingDeg: cardinal, confidence: 'low' });
      } else if (Number.isFinite(axis)) {
        result.set(item, { headingDeg: axis, confidence: 'low' });
      }
    }
  }
  return result;
}

/**
 * Only register stream/snapshot URLs on public Taiwanese hosts. The proxy
 * fetches catalog URLs server-side, so this pins what an upstream catalog can
 * point the proxy at.
 *
 * @param {string} raw
 * @param {{allowHttp?: boolean, hostSuffixes: string[]}} options
 * @returns {string} The normalized URL, or '' when refused.
 */
export function pinTaiwanMediaUrl(raw, { allowHttp = false, hostSuffixes }) {
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    return '';
  }
  const protocolOk =
    parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:');
  if (!protocolOk || parsed.username || parsed.password) return '';
  const host = parsed.hostname.toLowerCase();
  // No IP literals: a camera host is always a named public host.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return '';
  if (!hostSuffixes.some((suffix) => host.endsWith(suffix))) return '';
  return parsed.toString();
}

/** Classify a TDX/MOTC stream URL. HLS is not proxied (segment URLs escape the proxy). */
export function taiwanFeedTypeForUrl(url) {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (path.endsWith('.m3u8')) return 'hls';
  if (/\.(jpe?g|png)$/.test(path)) return 'image';
  if (path.endsWith('.mp4')) return 'mp4';
  return 'mjpeg';
}

function cameraName(record) {
  const road = record.RoadName || '';
  const mile = record.LocationMile || '';
  const dir = DIRECTION_ZH[record.RoadDirection] || '';
  const start = record.RoadSection?.Start;
  const end = record.RoadSection?.End;
  const section = start && end ? `(${start}–${end})` : '';
  const description = record.SurveillanceDescription || '';
  const base = [road, mile, dir].filter(Boolean).join(' ');
  return (
    `${base}${section ? ` ${section}` : ''}`.trim() ||
    description ||
    record.CCTVID
  );
}

/**
 * Convert MOTC CCTV records into catalog sources.
 *
 * @param {Array<object>} records
 * @param {object} pack
 * @returns {Array<object>}
 */
export function motcRecordsToSources(records, pack) {
  const staged = [];
  let skippedHls = 0;
  for (const record of records) {
    const rawId = String(record?.CCTVID || '').trim();
    if (!rawId) continue;
    const lat = toFiniteNumber(record.PositionLat);
    const lon = toFiniteNumber(record.PositionLon);
    if (!isLikelyTaiwanCoordinate(lat, lon)) continue;
    const streamUrl = pinTaiwanMediaUrl(record.VideoStreamURL, pack.pin);
    const imageUrl = pinTaiwanMediaUrl(record.VideoImageURL, pack.pin);
    if (!streamUrl && !imageUrl) continue;
    const feedType = streamUrl ? taiwanFeedTypeForUrl(streamUrl) : 'image';
    if (feedType === 'hls') {
      if (!imageUrl) {
        skippedHls += 1;
        continue;
      }
    }
    const usable = feedType === 'hls' ? 'image' : feedType;
    staged.push({
      record,
      lat,
      lon,
      source: {
        id: `${pack.idPrefix}-${rawId}`,
        name: cameraName(record),
        city: pack.cityFor(record),
        cityId: 'taiwan',
        provider: pack.provider,
        lat,
        lon,
        pitchDeg: -14,
        fovDeg: 50,
        rangeM: 260,
        mountHeightM: 9,
        groundElevationM: TAIWAN_GROUND_ELEVATION_M,
        feedType: usable,
        url: usable === 'image' ? imageUrl || streamUrl : streamUrl,
        snapshotUrl: imageUrl,
        sourceKind: pack.sourceKind,
        license: pack.license,
        code: [record.RoadName, record.LocationMile, record.RoadDirection]
          .filter(Boolean)
          .join(' ')
          .slice(0, 28),
      },
    });
  }
  const headings = deriveRoadHeadings(
    staged.map((entry) => {
      entry.key = `${entry.record.RoadID || entry.record.RoadName}|${entry.record.RoadDirection}`;
      entry.mileKm = parseLocationMileKm(entry.record.LocationMile);
      entry.direction = String(entry.record.RoadDirection || '').toUpperCase();
      return entry;
    }),
  );
  const unique = new Map();
  for (const entry of staged) {
    const pose = headings.get(entry);
    unique.set(entry.source.id, {
      ...entry.source,
      headingDeg: pose
        ? pose.headingDeg
        : fallbackHeadingFromId(entry.source.id),
      headingConfidence: pose ? pose.confidence : 'low',
    });
  }
  if (skippedHls) {
    console.log(
      `[CCTV] ${pack.provider}: skipped ${skippedHls} HLS-only cameras (not proxyable)`,
    );
  }
  return Array.from(unique.values());
}

function packCap(envName, fallback, ceiling = 2000) {
  const raw = Number(process.env[envName] || fallback);
  return Number.isFinite(raw)
    ? Math.max(8, Math.min(ceiling, Math.floor(raw)))
    : fallback;
}

const FREEWAY_PACK = Object.freeze({
  idPrefix: 'tw-freeway',
  provider: '交通部高速公路局 Freeway Bureau, MOTC',
  sourceKind: 'tw-freeway',
  license: 'Taiwan Freeway Bureau open data (政府資料開放授權條款)',
  pin: { allowHttp: false, hostSuffixes: ['.freeway.gov.tw', '.thb.gov.tw'] },
  cityFor: (record) => record.RoadName || 'Taiwan',
});

/**
 * Load the Freeway Bureau CCTV catalog (keyless).
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadTaiwanFreewaySourcesFromOpenData() {
  const endpoint =
    process.env.CCTV_TAIWAN_FREEWAY_URL || TAIWAN_FREEWAY_CCTV_URL;
  try {
    const resp = await fetch(endpoint, {
      headers: {
        Accept: 'application/xml,text/xml,*/*',
        'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
      },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(
        '[CCTV] Taiwan freeway catalog download failed:',
        resp.status,
      );
      return [];
    }
    const { tooLarge, text } = await readCappedResponseText(
      resp,
      TAIWAN_FREEWAY_MAX_CATALOG_BYTES,
    );
    if (tooLarge) {
      console.warn('[CCTV] Taiwan freeway catalog exceeds size cap');
      return [];
    }
    const cameras = motcRecordsToSources(parseMotcCctvXml(text), FREEWAY_PACK);
    const maxCount = packCap(
      'CCTV_TAIWAN_FREEWAY_MAX_SOURCES',
      DEFAULT_TAIWAN_FREEWAY_MAX_SOURCES,
    );
    const prioritized = prioritizeSources(cameras, maxCount, TAIWAN_ANCHORS);
    console.log(
      `[CCTV] Loaded Taiwan freeway camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Taiwan freeway catalog error:',
      error?.message || error,
    );
    return [];
  }
}

let tdxToken = { value: '', expiresAt: 0, clientId: '' };

async function getTdxAccessToken(clientId, clientSecret) {
  const now = Date.now();
  if (
    tdxToken.value &&
    tdxToken.clientId === clientId &&
    now < tdxToken.expiresAt - 60_000
  ) {
    return tdxToken.value;
  }
  const resp = await fetch(TDX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`TDX token HTTP ${resp.status}`);
  const body = await resp.json();
  if (!body?.access_token) throw new Error('TDX token response missing token');
  tdxToken = {
    value: body.access_token,
    expiresAt: now + (Number(body.expires_in) || 3600) * 1000,
    clientId,
  };
  return tdxToken.value;
}

const TDX_CITY_ZH = Object.freeze({
  Taipei: '臺北市',
  NewTaipei: '新北市',
  Taoyuan: '桃園市',
  Taichung: '臺中市',
  Tainan: '臺南市',
  Kaohsiung: '高雄市',
  Keelung: '基隆市',
  Hsinchu: '新竹市',
  HsinchuCounty: '新竹縣',
  MiaoliCounty: '苗栗縣',
  ChanghuaCounty: '彰化縣',
  NantouCounty: '南投縣',
  YunlinCounty: '雲林縣',
  ChiayiCounty: '嘉義縣',
  Chiayi: '嘉義市',
  PingtungCounty: '屏東縣',
  YilanCounty: '宜蘭縣',
  HualienCounty: '花蓮縣',
  TaitungCounty: '臺東縣',
  KinmenCounty: '金門縣',
  PenghuCounty: '澎湖縣',
  LienchiangCounty: '連江縣',
});

function tdxPackFor(scope) {
  const isHighway = scope === 'Highway';
  return {
    idPrefix: `tw-tdx-${scope.toLowerCase()}`,
    provider: isHighway
      ? '交通部公路局 Highway Bureau (TDX)'
      : `${TDX_CITY_ZH[scope] || scope} (TDX)`,
    sourceKind: 'tw-tdx',
    license: 'MOTC TDX open data (政府資料開放授權條款)',
    // City camera hosts vary by municipality and many are plain HTTP.
    pin: { allowHttp: true, hostSuffixes: ['.tw', '.taipei'] },
    cityFor: (record) =>
      isHighway ? record.RoadName || '省道' : TDX_CITY_ZH[scope] || scope,
  };
}

/**
 * Load provincial-highway and city cameras from TDX. Returns [] unless
 * TDX_CLIENT_ID and TDX_CLIENT_SECRET are configured.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadTaiwanTdxSources() {
  const clientId = String(process.env.TDX_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.TDX_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return [];
  try {
    const token = await getTdxAccessToken(clientId, clientSecret);
    const cities = String(
      process.env.CCTV_TDX_CITIES ?? DEFAULT_TDX_CCTV_CITIES,
    )
      .split(',')
      .map((city) => city.trim())
      .filter((city) => /^[A-Za-z]+$/.test(city));
    const scopes = ['Highway', ...cities];
    const results = await Promise.allSettled(
      scopes.map(async (scope) => {
        const path =
          scope === 'Highway'
            ? '/api/basic/v2/Road/Traffic/CCTV/Highway'
            : `/api/basic/v2/Road/Traffic/CCTV/City/${scope}`;
        const resp = await fetch(`${TDX_API_ORIGIN}${path}?$format=JSON`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Accept-Encoding': 'gzip',
          },
          signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
        });
        if (!resp.ok) throw new Error(`${scope} HTTP ${resp.status}`);
        const body = await resp.json();
        const records = Array.isArray(body?.CCTVs)
          ? body.CCTVs
          : Array.isArray(body)
            ? body
            : [];
        return motcRecordsToSources(records, tdxPackFor(scope));
      }),
    );
    const cameras = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') cameras.push(...result.value);
      else
        console.warn(
          `[CCTV] TDX ${scopes[index]} CCTV failed:`,
          result.reason?.message || result.reason,
        );
    });
    const maxCount = packCap('CCTV_TDX_MAX_SOURCES', DEFAULT_TDX_MAX_SOURCES);
    const prioritized = prioritizeSources(cameras, maxCount, TAIWAN_ANCHORS);
    console.log(
      `[CCTV] Loaded TDX camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] TDX CCTV error:', error?.message || error);
    return [];
  }
}
