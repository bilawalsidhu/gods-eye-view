import { SerialPort } from 'serialport';
import protobuf from 'protobufjs';

const { Root, Type, Field } = protobuf;

const START1 = 0x94;
const START2 = 0xc3;
const MAX_FRAME = 512;

const POSITION_APP = 3;
const NODEINFO_APP = 4;

function nodeIdFromNum(num) {
  return `!${Number(num >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function createCodec() {
  const root = new Root();
  const ns = root.define('meshtastic');

  const Data = new Type('UsbData')
    .add(new Field('portnum', 1, 'uint32'))
    .add(new Field('payload', 2, 'bytes'));
  ns.add(Data);

  const Position = new Type('UsbPosition')
    .add(new Field('latitude_i', 1, 'sfixed32'))
    .add(new Field('longitude_i', 2, 'sfixed32'))
    .add(new Field('altitude', 3, 'int32'))
    .add(new Field('time', 4, 'fixed32'))
    .add(new Field('precision_bits', 23, 'uint32'));
  ns.add(Position);

  const User = new Type('UsbUser')
    .add(new Field('id', 1, 'string'))
    .add(new Field('long_name', 2, 'string'))
    .add(new Field('short_name', 3, 'string'))
    .add(new Field('hw_model', 5, 'uint32'))
    .add(new Field('role', 7, 'uint32'));
  ns.add(User);

  const MeshPacket = new Type('UsbMeshPacket')
    .add(new Field('from', 1, 'fixed32'))
    .add(new Field('decoded', 4, 'UsbData'))
    .add(new Field('rx_time', 7, 'fixed32'))
    .add(new Field('via_mqtt', 14, 'bool'));
  ns.add(MeshPacket);

  const NodeInfo = new Type('UsbNodeInfo')
    .add(new Field('num', 1, 'uint32'))
    .add(new Field('user', 2, 'UsbUser'))
    .add(new Field('position', 3, 'UsbPosition'))
    .add(new Field('snr', 4, 'float'))
    .add(new Field('last_heard', 5, 'fixed32'))
    .add(new Field('channel', 7, 'uint32'))
    .add(new Field('via_mqtt', 8, 'bool'))
    .add(new Field('hops_away', 9, 'uint32'))
    .add(new Field('heard_on_current_lora', 15, 'bool'));
  ns.add(NodeInfo);

  const FromRadio = new Type('UsbFromRadio')
    .add(new Field('id', 1, 'uint32'))
    .add(new Field('packet', 2, 'UsbMeshPacket'))
    .add(new Field('node_info', 4, 'UsbNodeInfo'))
    .add(new Field('config_complete_id', 7, 'uint32'))
    .add(new Field('rebooted', 8, 'bool'));
  ns.add(FromRadio);

  const Heartbeat = new Type('UsbHeartbeat').add(
    new Field('nonce', 1, 'uint32'),
  );
  ns.add(Heartbeat);

  const ToRadio = new Type('UsbToRadio')
    .add(new Field('want_config_id', 3, 'uint32'))
    .add(new Field('disconnect', 4, 'bool'))
    .add(new Field('heartbeat', 7, 'UsbHeartbeat'));
  ns.add(ToRadio);

  root.resolveAll();

  return {
    Position,
    User,
    FromRadio,
    ToRadio,
  };
}

const codec = createCodec();

function frame(payload) {
  if (payload.length > MAX_FRAME) {
    throw new Error(`Meshtastic USB frame too large: ${payload.length}`);
  }

  const header = Buffer.from([
    START1,
    START2,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
  ]);

  return Buffer.concat([header, Buffer.from(payload)]);
}

export function createMeshtasticUsb({ path, ingest, onState = () => {} } = {}) {
  if (!path) throw new TypeError('Meshtastic USB path required');
  if (typeof ingest !== 'function')
    throw new TypeError('Meshtastic USB ingest callback required');

  let port = null;
  let buffer = Buffer.alloc(0);
  let heartbeatTimer = null;

  const nodeDb = new Map();

  let configNonce = 0;

  function state(values) {
    onState(values);
  }

  function send(message) {
    if (!port?.isOpen) return;

    const payload = codec.ToRadio.encode(message).finish();
    port.write(frame(payload));
  }

  function requestConfig() {
    configNonce = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;

    send({
      want_config_id: configNonce,
    });

    state({
      handshake: 'loading',
      configNonce,
    });

    console.log(`[Meshtastic USB] requesting node DB (nonce ${configNonce})`);
  }

  function observationFromNodeInfo(info) {
    if (!info?.num || !info?.position) return null;

    /*
     * Do not call MQTT-imported NodeDB entries "local".
     * heard_on_current_lora is the strongest current-firmware indication
     * that this radio has actually heard the node over RF.
     */
    // Keep MQTT-imported NodeDB entries out of the local RF layer.
    // heard_on_current_lora is not reliably populated during the
    // initial PhoneAPI NodeDB download, so don't require it here.
    if (info.via_mqtt) return null;

    const pos = info.position;

    const lat = Number(pos.latitude_i) * 1e-7;
    const lon = Number(pos.longitude_i) * 1e-7;

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180 ||
      (lat === 0 && lon === 0)
    ) {
      return null;
    }

    const user = info.user || {};
    const rawPrecision = Number(pos.precision_bits || 0);

    return {
      id: user.id || nodeIdFromNum(info.num),
      nodeNum: Number(info.num >>> 0),

      longName: user.long_name || null,
      shortName: user.short_name || null,

      latitude: lat,
      longitude: lon,

      altitude: pos.altitude === undefined ? null : Number(pos.altitude),

      positionPrecision: rawPrecision > 0 ? rawPrecision : null,

      positionPrecisionRaw: rawPrecision,

      hardwareModelCode: Number(user.hw_model || 0),
      roleCode: Number(user.role || 0),

      channelIndex: Number(info.channel || 0),
      hopsAway: info.hops_away === undefined ? null : Number(info.hops_away),

      snr: info.snr === undefined ? null : Number(info.snr),

      heardOnCurrentLora: Boolean(info.heard_on_current_lora),
      viaMqtt: Boolean(info.via_mqtt),

      retained: false,
      source: 'local_usb',

      observedAt:
        Number(info.last_heard || 0) > 0
          ? Number(info.last_heard) * 1000
          : Date.now(),
    };
  }

  function ingestNodeInfo(info) {
    if (!info?.num) return;

    const previous = nodeDb.get(info.num) || {};

    const merged = {
      ...previous,
      ...info,
      user: {
        ...(previous.user || {}),
        ...(info.user || {}),
      },
      position: info.position
        ? {
            ...(previous.position || {}),
            ...info.position,
          }
        : previous.position,
    };

    nodeDb.set(info.num, merged);

    const observation = observationFromNodeInfo(merged);

    if (observation) ingest(observation);
  }

  function handlePacket(packet) {
    const decoded = packet?.decoded;
    if (!decoded?.payload) return;

    const num = Number(packet.from >>> 0);

    let current = nodeDb.get(num) || {
      num,
      via_mqtt: Boolean(packet.via_mqtt),
      heard_on_current_lora: !packet.via_mqtt,
    };

    if (Number(decoded.portnum) === POSITION_APP) {
      try {
        const position = codec.Position.decode(decoded.payload);

        current = {
          ...current,
          num,
          position: {
            ...(current.position || {}),
            ...position,
          },
          via_mqtt: Boolean(packet.via_mqtt),
          heard_on_current_lora: !packet.via_mqtt,
          last_heard: Math.floor(Date.now() / 1000),
        };

        nodeDb.set(num, current);

        const observation = observationFromNodeInfo(current);
        if (observation) ingest(observation);
      } catch (error) {
        console.warn(
          '[Meshtastic USB] position decode:',
          error?.message || error,
        );
      }
    }

    if (Number(decoded.portnum) === NODEINFO_APP) {
      try {
        const user = codec.User.decode(decoded.payload);

        current = {
          ...current,
          num,
          user: {
            ...(current.user || {}),
            ...user,
          },
          via_mqtt: Boolean(packet.via_mqtt),
          heard_on_current_lora: !packet.via_mqtt,
          last_heard: Math.floor(Date.now() / 1000),
        };

        nodeDb.set(num, current);

        const observation = observationFromNodeInfo(current);
        if (observation) ingest(observation);
      } catch (error) {
        console.warn(
          '[Meshtastic USB] nodeinfo decode:',
          error?.message || error,
        );
      }
    }
  }

  function handleFromRadio(message) {
    state({
      lastMessageAt: Date.now(),
    });

    if (message.rebooted) {
      console.log('[Meshtastic USB] radio rebooted; refreshing node DB');
      nodeDb.clear();
      requestConfig();
      return;
    }

    if (message.node_info) {
      ingestNodeInfo(message.node_info);
      return;
    }

    if (message.packet) {
      handlePacket(message.packet);
      return;
    }

    if (
      message.config_complete_id &&
      Number(message.config_complete_id) === configNonce
    ) {
      state({
        handshake: 'ready',
        nodeDbCount: nodeDb.size,
      });

      console.log(`[Meshtastic USB] node DB ready: ${nodeDb.size} entries`);
    }
  }

  function parse() {
    while (buffer.length >= 4) {
      let start = -1;

      for (let i = 0; i < buffer.length - 1; i++) {
        if (buffer[i] === START1 && buffer[i + 1] === START2) {
          start = i;
          break;
        }
      }

      if (start < 0) {
        buffer = buffer.slice(-1);
        return;
      }

      if (start > 0) buffer = buffer.slice(start);

      if (buffer.length < 4) return;

      const length = (buffer[2] << 8) | buffer[3];

      if (length > MAX_FRAME) {
        buffer = buffer.slice(1);
        continue;
      }

      if (buffer.length < 4 + length) return;

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      try {
        handleFromRadio(codec.FromRadio.decode(payload));
      } catch (error) {
        console.warn(
          '[Meshtastic USB] FromRadio decode:',
          error?.message || error,
        );
      }
    }
  }

  function start() {
    if (port) return;

    state({
      connected: false,
      handshake: 'opening',
      error: null,
      path,
    });

    port = new SerialPort({
      path,
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      autoOpen: true,
    });

    port.on('open', () => {
      console.log(`[Meshtastic USB] connected: ${path}`);

      state({
        connected: true,
        handshake: 'connected',
        error: null,
      });

      /*
       * Give boot/debug output a moment to clear before switching into
       * protobuf PhoneAPI mode.
       */
      // Match the official Meshtastic stream client:
      // send 32 bogus START2 bytes to wake/resync the firmware parser,
      // then begin the PhoneAPI configuration download.
      const wake = Buffer.alloc(32, START2);

      port.write(wake, (error) => {
        if (error) {
          state({
            error: error.message,
          });
          return;
        }

        port.drain(() => {
          setTimeout(requestConfig, 100);
        });
      });

      heartbeatTimer = setInterval(() => {
        send({
          heartbeat: {
            nonce: Date.now() >>> 0,
          },
        });
      }, 60000);
    });

    port.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      parse();
    });

    port.on('error', (error) => {
      state({
        connected: false,
        error: error.message,
      });

      console.warn('[Meshtastic USB] serial error:', error.message);
    });

    port.on('close', () => {
      state({
        connected: false,
        handshake: 'closed',
      });

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    });
  }

  function close() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;

    if (port?.isOpen) {
      try {
        send({ disconnect: true });
      } catch {
        // Best-effort disconnect.
      }

      port.close();
    }

    port = null;
    buffer = Buffer.alloc(0);
  }

  return {
    start,
    close,
  };
}
