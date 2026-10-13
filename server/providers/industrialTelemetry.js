import http from 'node:http';
import https from 'node:https';
import { parseTapAddress } from '../../src/data/tapAddress.js';

export const LOCAL_TELEMETRY_ROUTE = '/api/telemetry';
export const LOCAL_TELEMETRY_FEEDS_ENV = 'LOCAL_TELEMETRY_FEEDS';
export const LOCAL_TELEMETRY_TIMEOUT_MS = 2_000;
export const LOCAL_TELEMETRY_MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOG_PREFIX = '[industrial-telemetry]';

/**
 * 12 default simulated industrial automation assets operating at major facilities.
 * Enables zero-setup, immediate verification and developer testing.
 */
export const SIMULATED_ASSETS = [
  // Giga Texas Autonomous Facility (Austin, TX)
  {
    id: 'agv-austin-01',
    name: 'Giga AGV Unit Alpha',
    facility: 'Tesla Giga Texas',
    city: 'Austin',
    country: 'US',
    type: 'agv',
    lat: 30.222,
    lon: -97.617,
    baseAlt: 140,
    heading: 45,
    speed: 3.2,
    radius: 0.003,
    periodSec: 60,
    status: 'nominal',
    battery: 92,
    metrics: {
      load_kg: 480,
      drive_temp_c: 41.2,
      vibration_rms: 0.12,
      subsystem: 'Body in White Transit',
    },
  },
  {
    id: 'agv-austin-02',
    name: 'Giga Tug Bravo',
    facility: 'Tesla Giga Texas',
    city: 'Austin',
    country: 'US',
    type: 'agv',
    lat: 30.224,
    lon: -97.619,
    baseAlt: 140,
    heading: 225,
    speed: 2.8,
    radius: 0.0025,
    periodSec: 75,
    status: 'nominal',
    battery: 81,
    metrics: {
      load_kg: 920,
      drive_temp_c: 44.5,
      vibration_rms: 0.18,
      subsystem: 'Stamping Press Feed',
    },
  },
  {
    id: 'drone-austin-01',
    name: 'Solar Roof Inspection UAV',
    facility: 'Tesla Giga Texas',
    city: 'Austin',
    country: 'US',
    type: 'drone',
    lat: 30.221,
    lon: -97.618,
    baseAlt: 210,
    heading: 90,
    speed: 12.5,
    radius: 0.004,
    periodSec: 90,
    status: 'nominal',
    battery: 68,
    metrics: {
      altitude_agl_m: 70,
      thermal_anomaly_count: 0,
      subsystem: 'Rooftop PV Array Survey',
    },
  },
  {
    id: 'pump-austin-01',
    name: 'Closed-Loop Chiller Pump #3',
    facility: 'Tesla Giga Texas',
    city: 'Austin',
    country: 'US',
    type: 'pump',
    lat: 30.225,
    lon: -97.615,
    baseAlt: 140,
    status: 'nominal',
    battery: 100,
    metrics: {
      flow_rate_gpm: 1250,
      pressure_psi: 82.4,
      motor_rpm: 1780,
      subsystem: 'Die Casting Cooling Loop',
    },
  },

  // Port of Rotterdam Automated Terminal (Rotterdam, Netherlands)
  {
    id: 'carrier-rotterdam-01',
    name: 'Automated Straddle Carrier #14',
    facility: 'ECT Delta Automated Terminal',
    city: 'Rotterdam',
    country: 'NL',
    type: 'vehicle',
    lat: 51.956,
    lon: 4.025,
    baseAlt: 2,
    heading: 180,
    speed: 4.8,
    radius: 0.0035,
    periodSec: 80,
    status: 'nominal',
    battery: 89,
    metrics: {
      container_id: 'MSCU-928174-0',
      gross_mass_teu: 2,
      subsystem: 'Quay to Stacking Yard',
    },
  },
  {
    id: 'carrier-rotterdam-02',
    name: 'Automated Straddle Carrier #22',
    facility: 'ECT Delta Automated Terminal',
    city: 'Rotterdam',
    country: 'NL',
    type: 'vehicle',
    lat: 51.958,
    lon: 4.028,
    baseAlt: 2,
    heading: 0,
    speed: 3.5,
    radius: 0.003,
    periodSec: 65,
    status: 'idle',
    battery: 74,
    metrics: {
      container_id: null,
      subsystem: 'Buffer Lane Standby',
    },
  },
  {
    id: 'crane-rotterdam-01',
    name: 'Super Post-Panamax STS Crane #08',
    facility: 'ECT Delta Automated Terminal',
    city: 'Rotterdam',
    country: 'NL',
    type: 'sensor',
    lat: 51.959,
    lon: 4.023,
    baseAlt: 45,
    status: 'nominal',
    battery: 100,
    metrics: {
      moves_per_hour: 34.2,
      wind_speed_knots: 14.2,
      trolley_position_pct: 64,
      subsystem: 'Berth 3 Unloading',
    },
  },

  // Dogger Bank Offshore Smart Wind Farm (North Sea, UK)
  {
    id: 'nacelle-dogger-01',
    name: 'Haliade-X 13MW Nacelle #07',
    facility: 'Dogger Bank Wind Array',
    city: 'North Sea',
    country: 'UK',
    type: 'sensor',
    lat: 54.75,
    lon: 1.92,
    baseAlt: 150,
    status: 'nominal',
    battery: 100,
    metrics: {
      power_mw: 11.8,
      rotor_rpm: 7.9,
      pitch_angle_deg: 2.4,
      yaw_deg: 215,
      subsystem: 'Array Generation',
    },
  },
  {
    id: 'drone-dogger-01',
    name: 'Blade Autonomous Inspection Drone',
    facility: 'Dogger Bank Wind Array',
    city: 'North Sea',
    country: 'UK',
    type: 'drone',
    lat: 54.751,
    lon: 1.923,
    baseAlt: 170,
    heading: 310,
    speed: 9.6,
    radius: 0.005,
    periodSec: 100,
    status: 'nominal',
    battery: 54,
    metrics: {
      target_turbine: 'WTG-07',
      wind_gust_ms: 12.1,
      subsystem: 'Leading-Edge Erosion Scan',
    },
  },

  // Jurong Island Industrial Cluster (Singapore)
  {
    id: 'robot-jurong-01',
    name: 'Autonomous HazMat Patrol AMR',
    facility: 'Jurong Petrochemical Island',
    city: 'Singapore',
    country: 'SG',
    type: 'robot',
    lat: 1.268,
    lon: 103.684,
    baseAlt: 5,
    heading: 135,
    speed: 1.4,
    radius: 0.002,
    periodSec: 120,
    status: 'warning',
    battery: 23,
    metrics: {
      voc_ppm: 0.04,
      flammable_gas_lel_pct: 0.0,
      alert: 'LOW_BATTERY_RTH',
      subsystem: 'Tank Farm Perimeter',
    },
  },
  {
    id: 'valve-jurong-01',
    name: 'Ethylene Cracker Isolation Valve #12',
    facility: 'Jurong Petrochemical Island',
    city: 'Singapore',
    country: 'SG',
    type: 'pump',
    lat: 1.271,
    lon: 103.687,
    baseAlt: 8,
    status: 'nominal',
    battery: 100,
    metrics: {
      line_pressure_bar: 34.8,
      fluid_temp_c: 64.2,
      actuator_position_pct: 100,
      subsystem: 'Feedstock Feed Isolation',
    },
  },
  {
    id: 'pump-jurong-fault',
    name: 'Desalination High-Pressure Booster',
    facility: 'Jurong Petrochemical Island',
    city: 'Singapore',
    country: 'SG',
    type: 'pump',
    lat: 1.265,
    lon: 103.689,
    baseAlt: 4,
    status: 'fault',
    battery: 100,
    metrics: {
      line_pressure_bar: 4.1,
      fluid_temp_c: 88.5,
      alert: 'CAVITATION_HIGH_VIBRATION',
      vibration_rms: 14.8,
      subsystem: 'Seawater Intake Secondary',
    },
  },
];

/**
 * Generate simulated live kinematic state for an asset.
 */
export function computeSimulatedState(asset, now = Date.now()) {
  const t = (now / 1000) % (asset.periodSec || 60);
  const angle = (2 * Math.PI * t) / (asset.periodSec || 60);

  let lat = asset.lat;
  let lon = asset.lon;
  let alt = asset.baseAlt || 0;
  let heading = asset.heading || 0;
  let speed = asset.speed || 0;

  if (asset.radius) {
    // Elliptical patrol path around base coordinates
    const dLat = asset.radius * Math.sin(angle);
    const dLon = asset.radius * Math.cos(angle) * 1.3;
    lat = asset.lat + dLat;
    lon = asset.lon + dLon;

    // Tangent heading in degrees
    const headingRad = Math.atan2(Math.cos(angle) * 1.3, -Math.sin(angle));
    heading = Math.round(((headingRad * 180) / Math.PI + 360) % 360);
  }

  return {
    id: asset.id,
    name: asset.name,
    facility: asset.facility,
    city: asset.city,
    country: asset.country,
    type: asset.type,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    alt: Math.round(alt),
    heading,
    speed,
    status: asset.status,
    battery: asset.battery,
    metrics: asset.metrics,
    updatedAt: new Date(now).toISOString(),
    source: 'IIoT Simulation',
  };
}

/**
 * Fetch one operator-configured telemetry feed over HTTP(S).
 */
async function fetchConfiguredFeed(feedUrl) {
  return new Promise((resolve, reject) => {
    const isHttps = feedUrl.startsWith('https://');
    const client = isHttps ? https : http;
    const req = client.get(
      feedUrl,
      { timeout: LOCAL_TELEMETRY_TIMEOUT_MS },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`Feed returned HTTP ${res.statusCode}`));
          return;
        }

        let body = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > LOCAL_TELEMETRY_MAX_BODY_BYTES) {
            req.destroy();
            reject(new Error('Feed response exceeded size limit'));
            return;
          }
          body += chunk;
        });

        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (err) {
            reject(new Error(`Feed JSON parse failed: ${err.message}`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Feed request timed out'));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Provider plugin for Industrial Telemetry / SCADA / IIoT edge feeds.
 */
export function industrialTelemetryProxy() {
  function getFeedsConfig() {
    const raw = process.env[LOCAL_TELEMETRY_FEEDS_ENV] || '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function validateFeedUrl(feedUrl) {
    try {
      const url = new URL(feedUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { valid: false, reason: 'Protocol must be http: or https:' };
      }
      const tap = parseTapAddress(url.host);
      if (!tap.ok) {
        return {
          valid: false,
          reason: `Host ${url.host} rejected: tap addresses must be loopback, RFC1918, localhost or *.local`,
        };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'Invalid URL format' };
    }
  }

  const installMiddleware = ({ middlewares }) => {
    middlewares.use(LOCAL_TELEMETRY_ROUTE, async (req, res) => {
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

      if (pathname === '/status') {
        const feeds = getFeedsConfig();
        sendJson(200, {
          configured: feeds.length > 0,
          feedCount: feeds.length,
          simulation: feeds.length === 0,
        });
        return;
      }

      const feeds = getFeedsConfig();

      if (feeds.length > 0) {
        // Operator configured local feeds
        const aggregated = [];
        for (const feedUrl of feeds) {
          const check = validateFeedUrl(feedUrl);
          if (!check.valid) {
            console.warn(
              `${LOG_PREFIX} Skipping untrusted feed URL ${feedUrl}: ${check.reason}`,
            );
            continue;
          }
          try {
            const data = await fetchConfiguredFeed(feedUrl);
            const items = Array.isArray(data?.devices)
              ? data.devices
              : Array.isArray(data)
                ? data
                : [];
            aggregated.push(...items);
          } catch (err) {
            console.warn(
              `${LOG_PREFIX} Feed fetch error for ${feedUrl}:`,
              err.message,
            );
          }
        }

        sendJson(200, {
          source: 'local-feeds',
          count: aggregated.length,
          devices: aggregated,
          fetchedAt: Date.now(),
        });
        return;
      }

      // Default: High-fidelity simulated industrial assets
      const now = Date.now();
      const devices = SIMULATED_ASSETS.map((asset) =>
        computeSimulatedState(asset, now),
      );

      sendJson(200, {
        source: 'simulation',
        count: devices.length,
        devices,
        fetchedAt: now,
      });
    });
  };

  return {
    name: 'industrial-telemetry-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
