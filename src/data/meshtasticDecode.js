import { fromBinary } from '@bufbuild/protobuf';
import { Mqtt, Mesh, Config, Portnums } from '@meshtastic/protobufs';
import { formatMeshtasticNodeId } from './meshtasticMapReport.js';

/**
 * @file Decodes one raw MQTT payload from mqtt.meshtastic.org's public
 * `msh/+/2/map/#` topic into a plain node record.
 *
 * Server-only (imported by vite.config.js's meshtasticProxy): pulls in the
 * full @meshtastic/protobufs definitions, which the browser layer
 * (meshtasticNodes.js) never needs — it only ever sees the already-decoded
 * JSON this produces.
 * @module data/meshtasticDecode
 */

const { ServiceEnvelopeSchema, MapReportSchema } = Mqtt;
const { HardwareModel } = Mesh;
const {
  Config_DeviceConfig_Role: Role,
  Config_LoRaConfig_RegionCode: RegionCode,
  Config_LoRaConfig_ModemPreset: ModemPreset,
} = Config;
const { PortNum } = Portnums;

/**
 * @param {Buffer|Uint8Array} payloadBuffer Raw MQTT message payload.
 * @returns {object|null} A plain node record, or null when this message
 *   isn't a public MapReport — including every ENCRYPTED packet, which is
 *   never inspected or decrypted (see issue #6's scope boundary), and any
 *   node reporting no GPS fix (lat/lon both exactly 0).
 */
export function decodeMeshtasticMapReportEnvelope(payloadBuffer) {
  const envelope = fromBinary(ServiceEnvelopeSchema, payloadBuffer);
  const packet = envelope.packet;
  const variant = packet?.payloadVariant;
  if (!variant || variant.case !== 'decoded' || variant.value.portnum !== PortNum.MAP_REPORT_APP) return null;

  const report = fromBinary(MapReportSchema, variant.value.payload);
  const latitude = report.latitudeI * 1e-7;
  const longitude = report.longitudeI * 1e-7;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude === 0 && longitude === 0) return null; // no GPS fix

  return {
    id: formatMeshtasticNodeId(Number(packet.from)),
    nodeNum: Number(packet.from) >>> 0,
    longName: report.longName || null,
    shortName: report.shortName || null,
    role: Role[report.role] ?? null,
    hwModel: HardwareModel[report.hwModel] ?? null,
    firmwareVersion: report.firmwareVersion || null,
    region: RegionCode[report.region] ?? null,
    modemPreset: ModemPreset[report.modemPreset] ?? null,
    latitude,
    longitude,
    altitude: Number.isFinite(report.altitude) ? report.altitude : null,
    positionPrecisionBits: Number.isFinite(report.positionPrecision) ? report.positionPrecision : null,
    numOnlineLocalNodes: Number.isFinite(report.numOnlineLocalNodes) ? report.numOnlineLocalNodes : null,
  };
}
