import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, toBinary } from '@bufbuild/protobuf';
import { Mqtt, Mesh, Portnums } from '@meshtastic/protobufs';
import { decodeMeshtasticMapReportEnvelope } from './meshtasticDecode.js';

const { ServiceEnvelopeSchema, MapReportSchema } = Mqtt;
const { MeshPacketSchema, DataSchema } = Mesh;
const { PortNum } = Portnums;

/** Build a real wire-encoded ServiceEnvelope, the way a Meshtastic gateway would. */
function encodeEnvelope({ from = 0xdad88120, portnum = PortNum.MAP_REPORT_APP, mapReport, encrypted } = {}) {
  const payloadVariant = encrypted
    ? { case: 'encrypted', value: new Uint8Array([1, 2, 3]) }
    : {
      case: 'decoded',
      value: create(DataSchema, {
        portnum,
        payload: toBinary(MapReportSchema, create(MapReportSchema, mapReport || {})),
      }),
    };
  const envelope = create(ServiceEnvelopeSchema, {
    packet: create(MeshPacketSchema, { from, to: 0xffffffff, payloadVariant }),
    channelId: 'LongFast',
    gatewayId: '!aabbccdd',
  });
  return toBinary(ServiceEnvelopeSchema, envelope);
}

test('decodeMeshtasticMapReportEnvelope: decodes a real MapReport round-trip', () => {
  const bytes = encodeEnvelope({
    from: 0xdad88120,
    mapReport: {
      longName: 'Test Node',
      shortName: 'TEST',
      role: 0, // CLIENT
      hwModel: 9, // RAK4631
      firmwareVersion: '2.7.26.54e0d8d',
      region: 1, // US
      modemPreset: 0, // LONG_FAST
      latitudeI: 321519616,
      longitudeI: -816185344,
      altitude: 53,
      positionPrecision: 14,
      numOnlineLocalNodes: 3,
    },
  });
  const record = decodeMeshtasticMapReportEnvelope(bytes);
  assert.equal(record.id, '!dad88120');
  assert.equal(record.longName, 'Test Node');
  assert.equal(record.shortName, 'TEST');
  assert.equal(record.role, 'CLIENT');
  assert.equal(record.hwModel, 'RAK4631');
  assert.equal(record.firmwareVersion, '2.7.26.54e0d8d');
  assert.equal(record.region, 'US');
  assert.equal(record.modemPreset, 'LONG_FAST');
  assert.ok(Math.abs(record.latitude - 32.1519616) < 1e-6);
  assert.ok(Math.abs(record.longitude - -81.6185344) < 1e-6);
  assert.equal(record.altitude, 53);
  assert.equal(record.positionPrecisionBits, 14);
  assert.equal(record.numOnlineLocalNodes, 3);
});

test('decodeMeshtasticMapReportEnvelope: never touches encrypted packets', () => {
  const bytes = encodeEnvelope({ encrypted: true });
  assert.equal(decodeMeshtasticMapReportEnvelope(bytes), null);
});

test('decodeMeshtasticMapReportEnvelope: ignores non-MapReport portnums', () => {
  const bytes = encodeEnvelope({ portnum: PortNum.POSITION_APP, mapReport: { latitudeI: 1, longitudeI: 1 } });
  assert.equal(decodeMeshtasticMapReportEnvelope(bytes), null);
});

test('decodeMeshtasticMapReportEnvelope: skips a report with no GPS fix (0,0)', () => {
  const bytes = encodeEnvelope({ mapReport: { latitudeI: 0, longitudeI: 0 } });
  assert.equal(decodeMeshtasticMapReportEnvelope(bytes), null);
});
