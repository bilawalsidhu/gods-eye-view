import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * 50 representative global industrial, manufacturing, and energy hubs.
 * Provides keyless global coverage via Open-Meteo Air Quality API batch queries,
 * or switches to OpenAQ v3 if OPENAQ_API_KEY is configured.
 */
export const INDUSTRIAL_AIR_QUALITY_HUBS = [
  // North America
  {
    id: 'aq-houston',
    name: 'Houston Ship Channel & Petrochemical Complex',
    city: 'Houston',
    country: 'US',
    lat: 29.73,
    lon: -95.12,
    type: 'Petrochemical / Refining',
  },
  {
    id: 'aq-gary',
    name: 'Calumet Industrial & Gary Steel Works',
    city: 'Gary',
    country: 'US',
    lat: 41.6,
    lon: -87.34,
    type: 'Steel & Heavy Manufacturing',
  },
  {
    id: 'aq-la-port',
    name: 'Port of Los Angeles & Long Beach Terminal',
    city: 'Los Angeles',
    country: 'US',
    lat: 33.74,
    lon: -118.27,
    type: 'Logistics & Marine Port',
  },
  {
    id: 'aq-baton-rouge',
    name: 'Mississippi Chemical Corridor',
    city: 'Baton Rouge',
    country: 'US',
    lat: 30.45,
    lon: -91.19,
    type: 'Chemical Refining',
  },
  {
    id: 'aq-monterrey',
    name: 'Monterrey Heavy Industrial Basin',
    city: 'Monterrey',
    country: 'MX',
    lat: 25.68,
    lon: -100.31,
    type: 'Steel & Automotive',
  },
  {
    id: 'aq-edmonton',
    name: 'Alberta Industrial Heartland',
    city: 'Edmonton',
    country: 'CA',
    lat: 53.54,
    lon: -113.49,
    type: 'Hydrocarbon Processing',
  },
  {
    id: 'aq-hamilton',
    name: 'Hamilton Bay Steel Corridor',
    city: 'Hamilton',
    country: 'CA',
    lat: 43.25,
    lon: -79.87,
    type: 'Steel Works',
  },

  // South America
  {
    id: 'aq-cubatao',
    name: 'Cubatão Industrial Pole',
    city: 'Cubatão',
    country: 'BR',
    lat: -23.89,
    lon: -46.42,
    type: 'Chemical & Steel',
  },
  {
    id: 'aq-sao-paulo',
    name: 'ABC Petrochemical & Automotive District',
    city: 'São Paulo',
    country: 'BR',
    lat: -23.67,
    lon: -46.53,
    type: 'Automotive & Refining',
  },
  {
    id: 'aq-santiago',
    name: 'Santiago Metropolitan Industrial Ring',
    city: 'Santiago',
    country: 'CL',
    lat: -33.45,
    lon: -70.66,
    type: 'Smelting & Manufacturing',
  },

  // Europe
  {
    id: 'aq-rotterdam',
    name: 'Port of Rotterdam Petrochemical Cluster',
    city: 'Rotterdam',
    country: 'NL',
    lat: 51.92,
    lon: 4.48,
    type: 'Petrochemical / Refinery',
  },
  {
    id: 'aq-antwerp',
    name: 'Port of Antwerp Chemical Industrial Cluster',
    city: 'Antwerp',
    country: 'BE',
    lat: 51.26,
    lon: 4.38,
    type: 'Chemical Logistics',
  },
  {
    id: 'aq-ruhr',
    name: 'Ruhr Valley / Duisburg Steel & Heavy Industry',
    city: 'Duisburg',
    country: 'DE',
    lat: 51.43,
    lon: 6.76,
    type: 'Steel & Metallurgy',
  },
  {
    id: 'aq-ludwigshafen',
    name: 'Ludwigshafen Verbund Chemical Complex',
    city: 'Ludwigshafen',
    country: 'DE',
    lat: 49.48,
    lon: 8.44,
    type: 'Chemical Production',
  },
  {
    id: 'aq-fos-sur-mer',
    name: 'Fos-sur-Mer Industrial & Maritime Complex',
    city: 'Marseille',
    country: 'FR',
    lat: 43.43,
    lon: 4.94,
    type: 'Steel & Refining',
  },
  {
    id: 'aq-le-havre',
    name: 'Seine Estuary Industrial Corridor',
    city: 'Le Havre',
    country: 'FR',
    lat: 49.49,
    lon: 0.11,
    type: 'Petrochemicals',
  },
  {
    id: 'aq-taranto',
    name: 'Taranto Metallurgical Basin',
    city: 'Taranto',
    country: 'IT',
    lat: 40.5,
    lon: 17.22,
    type: 'Steel Works',
  },
  {
    id: 'aq-po-valley',
    name: 'Po Valley Industrial Belt',
    city: 'Milan',
    country: 'IT',
    lat: 45.46,
    lon: 9.19,
    type: 'Manufacturing & Power',
  },
  {
    id: 'aq-silesia',
    name: 'Upper Silesian Industrial Basin',
    city: 'Katowice',
    country: 'PL',
    lat: 50.26,
    lon: 19.03,
    type: 'Coal & Heavy Industry',
  },
  {
    id: 'aq-bilbao',
    name: 'Nervión Industrial Port & Refinery',
    city: 'Bilbao',
    country: 'ES',
    lat: 43.26,
    lon: -2.93,
    type: 'Metallurgy & Marine',
  },
  {
    id: 'aq-tees-valley',
    name: 'Tees Valley Industrial Cluster',
    city: 'Middlesbrough',
    country: 'GB',
    lat: 54.58,
    lon: -1.23,
    type: 'Chemical & Steel',
  },
  {
    id: 'aq-grangemouth',
    name: 'Grangemouth Refinery & Petrochemical Works',
    city: 'Falkirk',
    country: 'GB',
    lat: 56.01,
    lon: -3.71,
    type: 'Refining',
  },
  {
    id: 'aq-ploiesti',
    name: 'Prahova Petrochemical Corridor',
    city: 'Ploiești',
    country: 'RO',
    lat: 44.93,
    lon: 26.03,
    type: 'Refining',
  },

  // Middle East & Africa
  {
    id: 'aq-jubail',
    name: 'Jubail Industrial City',
    city: 'Jubail',
    country: 'SA',
    lat: 27.01,
    lon: 49.66,
    type: 'Petrochemical Complex',
  },
  {
    id: 'aq-yanbu',
    name: 'Yanbu Industrial City',
    city: 'Yanbu',
    country: 'SA',
    lat: 24.09,
    lon: 38.06,
    type: 'Refinery & Hydrocarbons',
  },
  {
    id: 'aq-ruwais',
    name: 'Ruwais Industrial Complex',
    city: 'Abu Dhabi',
    country: 'AE',
    lat: 24.11,
    lon: 52.73,
    type: 'Petrochemicals & Gas',
  },
  {
    id: 'aq-ras-laffan',
    name: 'Ras Laffan Industrial City',
    city: 'Ras Laffan',
    country: 'QA',
    lat: 25.91,
    lon: 51.52,
    type: 'LNG & Petrochemicals',
  },
  {
    id: 'aq-secunda',
    name: 'Secunda CTL Synthetic Fuels Plant',
    city: 'Secunda',
    country: 'ZA',
    lat: -26.51,
    lon: 29.17,
    type: 'Synfuels & Chemicals',
  },
  {
    id: 'aq-alexandria',
    name: 'Alexandria Heavy Industrial Zone',
    city: 'Alexandria',
    country: 'EG',
    lat: 31.2,
    lon: 29.91,
    type: 'Petrochemicals & Cement',
  },
  {
    id: 'aq-skikda',
    name: 'Skikda Petrochemical Platform',
    city: 'Skikda',
    country: 'DZ',
    lat: 36.88,
    lon: 6.9,
    type: 'LNG & Refining',
  },

  // East & Southeast Asia
  {
    id: 'aq-ulsan',
    name: 'Ulsan Industrial District & Hyundai Shipyards',
    city: 'Ulsan',
    country: 'KR',
    lat: 35.53,
    lon: 129.31,
    type: 'Automotive, Heavy & Refining',
  },
  {
    id: 'aq-pohang',
    name: 'POSCO Pohang Integrated Steelworks',
    city: 'Pohang',
    country: 'KR',
    lat: 36.02,
    lon: 129.37,
    type: 'Steel Manufacturing',
  },
  {
    id: 'aq-incheon',
    name: 'Incheon Coastal Industrial Complex',
    city: 'Incheon',
    country: 'KR',
    lat: 37.45,
    lon: 126.7,
    type: 'Manufacturing & Port',
  },
  {
    id: 'aq-keihin',
    name: 'Keihin Industrial Zone / Tokyo Bay',
    city: 'Kawasaki',
    country: 'JP',
    lat: 35.53,
    lon: 139.7,
    type: 'Steel & Chemical Refining',
  },
  {
    id: 'aq-chukyo',
    name: 'Chukyo Industrial Belt',
    city: 'Nagoya',
    country: 'JP',
    lat: 35.18,
    lon: 136.9,
    type: 'Automotive & Heavy Industry',
  },
  {
    id: 'aq-hanshin',
    name: 'Hanshin Coastal Industrial Zone',
    city: 'Osaka',
    country: 'JP',
    lat: 34.69,
    lon: 135.5,
    type: 'Machinery & Metallurgy',
  },
  {
    id: 'aq-baoshan',
    name: 'Baoshan Steel & Northern Shanghai Harbor',
    city: 'Shanghai',
    country: 'CN',
    lat: 31.4,
    lon: 121.48,
    type: 'Steel & Logistics',
  },
  {
    id: 'aq-prd',
    name: 'Pearl River Delta Industrial Corridor',
    city: 'Shenzhen',
    country: 'CN',
    lat: 22.54,
    lon: 114.05,
    type: 'Electronics & Manufacturing',
  },
  {
    id: 'aq-tangshan',
    name: 'Tangshan Heavy Steel Basin',
    city: 'Tangshan',
    country: 'CN',
    lat: 39.63,
    lon: 118.18,
    type: 'Steel Smelting',
  },
  {
    id: 'aq-kaohsiung',
    name: 'Kaohsiung Heavy Industrial Port',
    city: 'Kaohsiung',
    country: 'TW',
    lat: 22.61,
    lon: 120.3,
    type: 'Steel, Petrochemical & Ship',
  },
  {
    id: 'aq-jurong',
    name: 'Jurong Island Petrochemical Complex',
    city: 'Singapore',
    country: 'SG',
    lat: 1.27,
    lon: 103.7,
    type: 'Petrochemical Refining',
  },
  {
    id: 'aq-map-ta-phut',
    name: 'Map Ta Phut Industrial Estate',
    city: 'Rayong',
    country: 'TH',
    lat: 12.68,
    lon: 101.16,
    type: 'Petrochemicals & Gas',
  },
  {
    id: 'aq-cilegon',
    name: 'Cilegon Industrial Zone & Krakatau Steel',
    city: 'Cilegon',
    country: 'ID',
    lat: -6.01,
    lon: 106.05,
    type: 'Steel & Chemical',
  },

  // South Asia
  {
    id: 'aq-mumbai-port',
    name: 'Navi Mumbai & Thane-Belapur Industrial Area',
    city: 'Mumbai',
    country: 'IN',
    lat: 19.03,
    lon: 73.02,
    type: 'Chemicals & Engineering',
  },
  {
    id: 'aq-dahej',
    name: 'Dahej Petroleum, Chemicals & Petrochemicals (PCPIR)',
    city: 'Bharuch',
    country: 'IN',
    lat: 21.71,
    lon: 72.58,
    type: 'Chemicals & LNG',
  },
  {
    id: 'aq-jamshedpur',
    name: 'Tata Steel Jamshedpur Industrial Works',
    city: 'Jamshedpur',
    country: 'IN',
    lat: 22.8,
    lon: 86.2,
    type: 'Steel Works',
  },
  {
    id: 'aq-asansol',
    name: 'Asansol-Durgapur Steel & Mining Belt',
    city: 'Durgapur',
    country: 'IN',
    lat: 23.52,
    lon: 87.31,
    type: 'Steel, Coal & Heavy',
  },

  // Oceania
  {
    id: 'aq-port-kembla',
    name: 'Port Kembla Steelworks Industrial Estate',
    city: 'Wollongong',
    country: 'AU',
    lat: -34.47,
    lon: 150.9,
    type: 'Steel & Port',
  },
  {
    id: 'aq-kwinana',
    name: 'Kwinana Strategic Industrial Area',
    city: 'Perth',
    country: 'AU',
    lat: -32.23,
    lon: 115.77,
    type: 'Refinery, Smelting & Lithium',
  },
  {
    id: 'aq-gladstone',
    name: 'Gladstone Heavy Industrial Harbor',
    city: 'Gladstone',
    country: 'AU',
    lat: -23.85,
    lon: 151.27,
    type: 'Alumina Smelting & LNG',
  },
];

/**
 * Classify US EPA Air Quality Index (0-500).
 * @param {number} aqi
 * @returns {{ level: string, label: string, color: string }}
 */
export function classifyAqi(aqi) {
  const value = Math.max(0, Math.round(Number(aqi) || 0));
  if (value <= 50) return { level: 'good', label: 'Good', color: '#00e400' };
  if (value <= 100)
    return { level: 'moderate', label: 'Moderate', color: '#ffff00' };
  if (value <= 150)
    return {
      level: 'unhealthy-sensitive',
      label: 'Unhealthy for Sensitive Groups',
      color: '#ff7e00',
    };
  if (value <= 200)
    return { level: 'unhealthy', label: 'Unhealthy', color: '#ff0000' };
  if (value <= 300)
    return {
      level: 'very-unhealthy',
      label: 'Very Unhealthy',
      color: '#8f3f97',
    };
  return { level: 'hazardous', label: 'Hazardous', color: '#7e0023' };
}

/**
 * Air Quality Live Provider with memory + disk caching.
 * Resolves live observations for industrial hubs across OpenAQ or Open-Meteo.
 *
 * @returns {import('vite').Plugin}
 */
export function airQualityProxy() {
  const TTL_MS = 15 * 60_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'air-quality.json');

  let mem = null;
  let diskChecked = false;
  let inflight = null;

  const openAqKey = () => String(process.env.OPENAQ_API_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.fetchedAt) &&
        Array.isArray(parsed?.stations)
      ) {
        mem = parsed;
      }
    } catch {
      /* no cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn(
        '[air-quality-proxy] cache write failed:',
        err?.message || err,
      );
    }
  }

  async function fetchOpenMeteoBatch() {
    const lats = INDUSTRIAL_AIR_QUALITY_HUBS.map((h) => h.lat.toFixed(2)).join(
      ',',
    );
    const lons = INDUSTRIAL_AIR_QUALITY_HUBS.map((h) => h.lon.toFixed(2)).join(
      ',',
    );
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lats}&longitude=${lons}&current=us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone`;

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'gods-eye-view/0.2.1 (https://github.com/bilawalsidhu/gods-eye-view)',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok)
      throw new Error(`Open-Meteo Air Quality error: HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data) ? data : [data];

    const stations = INDUSTRIAL_AIR_QUALITY_HUBS.map((hub, idx) => {
      const reading = items[idx]?.current || {};
      const aqi = Math.round(reading.us_aqi ?? 25);
      const { label, color, level } = classifyAqi(aqi);

      let primaryPollutant = 'PM2.5';
      if ((reading.pm10 || 0) > (reading.pm2_5 || 0) * 2)
        primaryPollutant = 'PM10';
      if ((reading.nitrogen_dioxide || 0) > 40) primaryPollutant = 'NO₂';
      if ((reading.sulphur_dioxide || 0) > 30) primaryPollutant = 'SO₂';

      return {
        id: hub.id,
        name: hub.name,
        city: hub.city,
        country: hub.country,
        industrialType: hub.type,
        lat: hub.lat,
        lon: hub.lon,
        aqi,
        category: label,
        level,
        color,
        primaryPollutant,
        pm25: reading.pm2_5 != null ? Number(reading.pm2_5.toFixed(1)) : null,
        pm10: reading.pm10 != null ? Number(reading.pm10.toFixed(1)) : null,
        no2:
          reading.nitrogen_dioxide != null
            ? Number(reading.nitrogen_dioxide.toFixed(1))
            : null,
        so2:
          reading.sulphur_dioxide != null
            ? Number(reading.sulphur_dioxide.toFixed(1))
            : null,
        co:
          reading.carbon_monoxide != null
            ? Number(reading.carbon_monoxide.toFixed(1))
            : null,
        o3: reading.ozone != null ? Number(reading.ozone.toFixed(1)) : null,
        timestamp: reading.time
          ? new Date(reading.time + 'Z').toISOString()
          : new Date().toISOString(),
        source: 'Open-Meteo Air Quality (CAMS / Copernicus)',
      };
    });

    return {
      fetchedAt: Date.now(),
      source: 'Open-Meteo / Copernicus Atmosphere',
      count: stations.length,
      stations,
    };
  }

  async function fetchOpenAq(apiKey) {
    const url =
      'https://api.openaq.org/v3/locations?limit=100&order_by=id&sort_order=asc';
    const res = await fetch(url, {
      headers: {
        'X-API-Key': apiKey,
        'User-Agent': 'gods-eye-view/0.2.1',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`OpenAQ upstream HTTP ${res.status}`);
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    const stations = results.map((item) => {
      const lat = item.coordinates?.latitude || 0;
      const lon = item.coordinates?.longitude || 0;
      let pm25 = null;
      let pm10 = null;
      let no2 = null;
      let so2 = null;

      if (Array.isArray(item.sensors)) {
        for (const s of item.sensors) {
          const param = String(s.parameter?.name || '').toLowerCase();
          const val = Number(s.latest?.value);
          if (!Number.isFinite(val)) continue;
          if (param === 'pm25') pm25 = Number(val.toFixed(1));
          if (param === 'pm10') pm10 = Number(val.toFixed(1));
          if (param === 'no2') no2 = Number(val.toFixed(1));
          if (param === 'so2') so2 = Number(val.toFixed(1));
        }
      }

      // Estimate US AQI from PM2.5 (ug/m3)
      const p = pm25 ?? (pm10 ? pm10 / 2 : 12);
      const aqi = Math.round(
        p <= 12
          ? (p / 12) * 50
          : p <= 35.4
            ? 50 + ((p - 12) / 23.4) * 50
            : 100 + ((p - 35.4) / 19.6) * 50,
      );
      const { label, color, level } = classifyAqi(aqi);

      return {
        id: `openaq-${item.id}`,
        name: item.name || 'Monitoring Station',
        city: item.locality || item.country?.name || 'Local',
        country: item.country?.code || '',
        industrialType: 'Ambient Air Monitoring Station',
        lat,
        lon,
        aqi,
        category: label,
        level,
        color,
        primaryPollutant:
          pm25 != null ? 'PM2.5' : pm10 != null ? 'PM10' : 'Ozone',
        pm25,
        pm10,
        no2,
        so2,
        co: null,
        o3: null,
        timestamp: item.datetimeLast?.utc || new Date().toISOString(),
        source: 'OpenAQ v3',
      };
    });

    return {
      fetchedAt: Date.now(),
      source: 'OpenAQ v3',
      count: stations.length,
      stations,
    };
  }

  async function refresh() {
    const key = openAqKey();
    if (key) {
      try {
        return await fetchOpenAq(key);
      } catch (err) {
        console.warn(
          '[air-quality-proxy] OpenAQ query failed, falling back to Open-Meteo:',
          err?.message || err,
        );
      }
    }
    return await fetchOpenMeteoBatch();
  }

  const installMiddleware = ({ middlewares }) => {
    middlewares.use('/api/air-quality', async (req, res) => {
      const sendJson = (status, payload) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(payload));
      };

      if (req.method !== 'GET') {
        sendJson(405, { error: 'Method not allowed' });
        return;
      }

      const pathname = req.url.split('?')[0];

      try {
        await readDiskOnce();

        if (pathname === '/status') {
          const key = openAqKey();
          sendJson(200, {
            hasKey: Boolean(key),
            source:
              mem?.source || (key ? 'OpenAQ v3' : 'Open-Meteo / Copernicus'),
            lastFetch: mem ? mem.fetchedAt : null,
            count: mem ? mem.count : null,
            stale: mem ? Date.now() - mem.fetchedAt >= TTL_MS : false,
            ttlMs: TTL_MS,
          });
          return;
        }

        const entry = mem;
        if (entry && Date.now() - entry.fetchedAt < TTL_MS) {
          sendJson(200, entry);
          return;
        }

        if (!inflight) {
          inflight = refresh()
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                '[air-quality-proxy] refresh failed:',
                err?.message || err,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }

        const fresh = await inflight;
        if (fresh) {
          sendJson(200, fresh);
        } else if (entry) {
          sendJson(200, { ...entry, stale: true });
        } else {
          sendJson(502, {
            error: 'Air quality fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[air-quality-proxy] error:', err?.message || err);
        sendJson(500, { error: 'Internal air quality proxy error' });
      }
    });
  };

  return {
    name: 'air-quality-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
