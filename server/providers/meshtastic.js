import mqtt from 'mqtt';
import protobuf from 'protobufjs';
import { createMeshtasticUsb } from './meshtastic-usb.js';

const { Root, Type, Field } = protobuf;

const MAP_REPORT_APP = 73;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function createCodec() {
  const root = new Root();
  const ns = root.define('meshtastic');

  const Data = new Type('Data')
    .add(new Field('portnum', 1, 'uint32'))
    .add(new Field('payload', 2, 'bytes'));

  ns.add(Data);

  const MeshPacket = new Type('MeshPacket')
    .add(new Field('from', 1, 'fixed32'))
    .add(new Field('decoded', 4, 'Data'));

  ns.add(MeshPacket);

  const ServiceEnvelope = new Type('ServiceEnvelope')
    .add(new Field('packet', 1, 'MeshPacket'))
    .add(new Field('channel_id', 2, 'string'))
    .add(new Field('gateway_id', 3, 'string'));

  ns.add(ServiceEnvelope);

  const MapReport = new Type('MapReport')
    .add(new Field('long_name', 1, 'string'))
    .add(new Field('short_name', 2, 'string'))
    .add(new Field('role', 3, 'uint32'))
    .add(new Field('hw_model', 4, 'uint32'))
    .add(new Field('firmware_version', 5, 'string'))
    .add(new Field('region', 6, 'uint32'))
    .add(new Field('modem_preset', 7, 'uint32'))
    .add(new Field('has_default_channel', 8, 'bool'))
    .add(new Field('latitude_i', 9, 'sfixed32'))
    .add(new Field('longitude_i', 10, 'sfixed32'))
    .add(new Field('altitude', 11, 'int32'))
    .add(new Field('position_precision', 12, 'uint32'))
    .add(new Field('num_online_local_nodes', 13, 'uint32'))
    .add(new Field('has_opted_report_location', 14, 'bool'));

  ns.add(MapReport);

  root.resolveAll();

  return { ServiceEnvelope, MapReport };
}

const codec = createCodec();

function nodeIdFromNum(num) {
  return `!${Number(num >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function freshness(lastSeen) {
  const age = Date.now() - lastSeen;
  if (age < 2 * 60 * 1000) return 'live';
  if (age < 30 * 60 * 1000) return 'recent';
  return 'stale';
}

/*
 * Unified observation store.
 *
 * public_mqtt and local_usb observations for the same node ID live in one
 * record. When USB support is enabled later, local USB becomes the preferred
 * observation without creating a second marker.
 */
function createNodeStore() {
  const records = new Map();

  function ingest(observation) {
    if (!observation?.id || !observation?.source) return;

    const now = observation.observedAt || Date.now();

    let record = records.get(observation.id);
    if (!record) {
      record = {
        id: observation.id,
        firstSeen: now,
        lastSeen: now,
        reportCount: 0,
        observations: {},
      };
      records.set(observation.id, record);
    }

    record.observations[observation.source] = {
      ...(record.observations[observation.source] || {}),
      ...observation,
      lastSeen: now,
    };

    record.lastSeen = Math.max(record.lastSeen, now);
    record.reportCount += 1;
  }

  function project(record) {
    const local = record.observations.local_usb;
    const mqttObservation = record.observations.public_mqtt;

    // Prefer locally heard data whenever available.
    const primary = local || mqttObservation;
    const secondary = local ? mqttObservation : null;

    if (!primary) return null;

    return {
      ...(secondary || {}),
      ...primary,

      id: record.id,
      source: local ? 'local_usb' : 'public_mqtt',
      sources: Object.keys(record.observations),

      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      reportCount: record.reportCount,
      freshness:
        primary.retained && !local ? 'retained' : freshness(record.lastSeen),
    };
  }

  function list(maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const cutoff = Date.now() - maxAgeMs;

    return [...records.values()]
      .filter((record) => record.lastSeen >= cutoff)
      .map(project)
      .filter(Boolean)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  function countBySource(source) {
    let total = 0;
    for (const record of records.values()) {
      if (record.observations[source]) total += 1;
    }
    return total;
  }

  return {
    ingest,
    list,
    get size() {
      return records.size;
    },
    countBySource,
  };
}

function decodePublicMapReport(payload, { retained = false } = {}) {
  const envelope = codec.ServiceEnvelope.decode(payload);
  const packet = envelope.packet;

  if (!packet?.decoded) return null;
  if (Number(packet.decoded.portnum) !== MAP_REPORT_APP) return null;

  const report = codec.MapReport.decode(packet.decoded.payload);

  const nodeNum = Number(packet.from >>> 0);
  const id = nodeIdFromNum(nodeNum);

  const hasLat = hasOwn(report, 'latitude_i');
  const hasLon = hasOwn(report, 'longitude_i');

  const rawPrecision = hasOwn(report, 'position_precision')
    ? Number(report.position_precision)
    : null;

  return {
    id,
    nodeNum,

    longName: report.long_name || null,
    shortName: report.short_name || null,

    latitude: hasLat && hasLon ? Number(report.latitude_i) * 1e-7 : null,
    longitude: hasLat && hasLon ? Number(report.longitude_i) * 1e-7 : null,

    altitude: hasOwn(report, 'altitude') ? Number(report.altitude) : null,

    // 0 + coordinates means "unknown/unspecified", not exact.
    positionPrecision:
      rawPrecision != null && rawPrecision > 0 ? rawPrecision : null,
    positionPrecisionRaw: rawPrecision,

    hardwareModelCode: Number(report.hw_model || 0),
    roleCode: Number(report.role || 0),
    regionCode: Number(report.region || 0),
    modemPresetCode: Number(report.modem_preset || 0),

    firmwareVersion: report.firmware_version || null,

    hasDefaultChannel: hasOwn(report, 'has_default_channel')
      ? Boolean(report.has_default_channel)
      : null,

    localNodeCount: hasOwn(report, 'num_online_local_nodes')
      ? Number(report.num_online_local_nodes)
      : null,

    hasOptedReportLocation: hasOwn(report, 'has_opted_report_location')
      ? Boolean(report.has_opted_report_location)
      : null,

    channel: envelope.channel_id || null,
    gatewayId: envelope.gateway_id || null,

    retained,
    source: 'public_mqtt',
    observedAt: Date.now(),
  };
}

export function meshtasticProxy() {
  const store = createNodeStore();

  const enabled = envBool('MESHTASTIC_ENABLED', false);

  const mqttEnabled = enabled && envBool('MESHTASTIC_MQTT_ENABLED', true);

  const usbEnabled = enabled && envBool('MESHTASTIC_USB_ENABLED', false);

  const usbPort = process.env.MESHTASTIC_USB_PORT || '';

  const state = {
    mqttConnected: false,
    mqttLastMessageAt: null,
    mqttLastError: null,

    usbConfigured: usbEnabled && Boolean(usbPort),
    usbConnected: false,
    usbLastError: null,
    usbLastMessageAt: null,
    usbHandshake: usbEnabled ? 'idle' : 'disabled',
    usbNodeDbCount: 0,
  };

  let client = null;
  let usb = null;

  function startMqtt() {
    if (!mqttEnabled || client) return;

    const url =
      process.env.MESHTASTIC_MQTT_URL || 'mqtts://mqtt.meshtastic.org:8883';

    const topic = process.env.MESHTASTIC_MQTT_TOPIC || 'msh/US/2/map/';

    client = mqtt.connect(url, {
      username: process.env.MESHTASTIC_MQTT_USER || 'meshdev',

      password: process.env.MESHTASTIC_MQTT_PASSWORD || 'large4cats',

      // We already verified this identifier against the public broker.
      clientId: process.env.MESHTASTIC_MQTT_CLIENT_ID || 'meshdev',

      clean: true,
      protocolVersion: 4,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      rejectUnauthorized: true,
    });

    client.on('connect', () => {
      state.mqttConnected = true;
      state.mqttLastError = null;

      console.log(`[Meshtastic] MQTT connected; subscribing to ${topic}`);

      client.subscribe(topic, { qos: 0 }, (error) => {
        if (error) {
          state.mqttLastError = error.message;
          console.warn('[Meshtastic] MQTT subscribe failed:', error.message);
        }
      });
    });

    client.on('reconnect', () => {
      state.mqttConnected = false;
    });

    client.on('close', () => {
      state.mqttConnected = false;
    });

    client.on('error', (error) => {
      state.mqttLastError = error.message;
      console.warn('[Meshtastic] MQTT:', error.message);
    });

    client.on('message', (_topic, payload, mqttPacket) => {
      try {
        const observation = decodePublicMapReport(payload, {
          retained: Boolean(mqttPacket?.retain),
        });

        if (!observation) return;

        store.ingest(observation);
        state.mqttLastMessageAt = Date.now();
      } catch (error) {
        console.warn(
          '[Meshtastic] map report decode failed:',
          error?.message || error,
        );
      }
    });
  }

  /*
   * USB hook intentionally exists now even though the transport is added
   * separately. The USB adapter will call:
   *
   *   store.ingest({
   *     id: '!abcd1234',
   *     source: 'local_usb',
   *     ...
   *   });
   *
   * That means MQTT + USB observations automatically collapse to one entity.
   */
  function startUsb() {
    if (!usbEnabled || !usbPort || usb) return;

    console.log(`[Meshtastic] starting USB radio on ${usbPort}`);

    try {
      usb = createMeshtasticUsb({
        path: usbPort,

        ingest(observation) {
          store.ingest(observation);
        },

        onState(update = {}) {
          if (Object.prototype.hasOwnProperty.call(update, 'connected')) {
            state.usbConnected = Boolean(update.connected);
          }

          if (Object.prototype.hasOwnProperty.call(update, 'error')) {
            state.usbLastError = update.error || null;
          }

          if (Object.prototype.hasOwnProperty.call(update, 'lastMessageAt')) {
            state.usbLastMessageAt = update.lastMessageAt || null;
          }

          if (Object.prototype.hasOwnProperty.call(update, 'handshake')) {
            state.usbHandshake = update.handshake || null;
          }

          if (Object.prototype.hasOwnProperty.call(update, 'nodeDbCount')) {
            state.usbNodeDbCount = Number(update.nodeDbCount) || 0;
          }
        },
      });

      usb.start();
    } catch (error) {
      state.usbConnected = false;
      state.usbLastError = error?.message || String(error);

      console.warn('[Meshtastic] USB startup failed:', state.usbLastError);

      usb = null;
    }
  }

  function sendJson(res, status, value) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
  }

  function install(server) {
    if (enabled) {
      startMqtt();
      startUsb();
    }

    server.middlewares.use('/api/meshtastic', async (req, res) => {
      const requestUrl = new URL(req.url || '/', 'http://localhost');

      if (requestUrl.pathname === '/status') {
        return sendJson(res, 200, {
          enabled,

          nodes: store.size,

          mqtt: {
            enabled: mqttEnabled,
            connected: state.mqttConnected,
            nodeCount: store.countBySource('public_mqtt'),
            lastMessageAt: state.mqttLastMessageAt,
            lastError: state.mqttLastError,
            topic: process.env.MESHTASTIC_MQTT_TOPIC || 'msh/US/2/map/',
          },

          usb: {
            enabled: usbEnabled,
            configured: state.usbConfigured,
            connected: state.usbConnected,
            port: usbPort || null,
            nodeCount: store.countBySource('local_usb'),
            nodeDbCount: state.usbNodeDbCount,
            handshake: state.usbHandshake,
            lastMessageAt: state.usbLastMessageAt,
            lastError: state.usbLastError,
          },
        });
      }

      if (requestUrl.pathname === '/nodes') {
        const requestedAge = Number(
          requestUrl.searchParams.get('maxAgeSec') || 7200,
        );

        const maxAgeSec =
          Number.isFinite(requestedAge) && requestedAge > 0
            ? Math.min(requestedAge, 86400)
            : 7200;

        return sendJson(res, 200, {
          generatedAt: Date.now(),
          count: store.list(maxAgeSec * 1000).length,
          nodes: store.list(maxAgeSec * 1000),
        });
      }

      return sendJson(res, 404, {
        error: 'Meshtastic endpoint not found',
      });
    });

    server.httpServer?.once('close', close);
  }

  function close() {
    if (client) {
      client.end(true);
      client = null;
    }

    if (usb) {
      try {
        usb.close();
      } catch (error) {
        console.warn('[Meshtastic] USB close failed:', error?.message || error);
      }

      usb = null;
    }

    state.mqttConnected = false;
    state.usbConnected = false;
    state.usbHandshake = 'closed';
  }

  return {
    name: 'meshtastic-provider',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle: close,
  };
}
