import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  buildPack,
  createRouteNames,
  createStateLookup,
  openZip,
} from '../../scripts/build-rail-paths.mjs';
import { getRegisteredRailFeed } from '../data/railFeeds.js';

/** A minimal stored (uncompressed) zip. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(locals.length / 3, 8);
  end.writeUInt16LE(locals.length / 3, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function withZip(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-routes-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'feed.zip');
  await writeFile(file, makeZip(files));
  const zip = await openZip(file);
  t.after(() => zip.handle.close());
  return zip;
}

test('states: Spanish provinces group into communities; abroad is abroad', async () => {
  const at = await createStateLookup();
  assert.deepEqual(at(40.4712, -3.683), { country: 'ES', state: 'ES-MD' });
  assert.deepEqual(at(38.8907, -6.9818), { country: 'ES', state: 'ES-EX' });
  assert.equal(at(41.3799, 2.141).state, 'ES-CT', 'Barcelona');
  assert.equal(at(36.5287, -6.2896).state, 'ES-AN', 'Cádiz, on the coast');
  assert.equal(at(43.3035, 5.3822).country, 'FR');
  assert.equal(at(Number.NaN, 0), null);
  assert.equal(at(0, -30), null, 'mid-ocean');
});

test('Renfe routes are renamed with product and community scope', async (t) => {
  const zip = await withZip(t, {
    'stops.txt': [
      'stop_id,stop_name,stop_lat,stop_lon',
      '17000,Madrid-Chamartín,40.4711789,-3.6829524',
      '37606,Badajoz,38.8906960,-6.9817530',
      '10200,Guadalajara,40.6440,-3.1820',
      '18000,Madrid-Atocha,40.4064,-3.6906',
    ].join('\n'),
  });
  const names = await createRouteNames(
    getRegisteredRailFeed('renfe-larga-distancia'),
    zip,
  );
  const route = (id, short, type = '2') =>
    names.route({ route_id: id, route_short_name: short, route_type: type });
  assert.equal(route('1700037606GL023', 'MD'), 'MD~X~1700037606GL023');
  assert.equal(
    route('1700018000GL001', 'REGIONAL'),
    'REGIONAL~S~1700018000GL001',
  );
  assert.equal(
    route('1700010200GL001', 'MD'),
    'MD~X~1700010200GL001',
    'Madrid to Castilla-La Mancha',
  );
  assert.equal(route('1700037606GL023', 'AUTOBUS'), null, 'an unknown product');
  assert.equal(route('1700037606GL023', 'MD', '3'), null, 'not rail');
  assert.equal(names.trip({ trip_id: 'x' }, 'MD~S~1'), 'MD~S~1');
});

test('a renamed route keeps its shapes under the new id in the path pack', async (t) => {
  const zip = await withZip(t, {
    'routes.txt': [
      'route_id,agency_id,route_short_name,route_type',
      '114876,IFF:NS,Intercity,2',
      '9,GVB,Tram 9,0',
    ].join('\n'),
    'trips.txt': [
      'route_id,service_id,trip_id,shape_id',
      '114876,s,338806760,sh1',
      '9,s,t9,sh2',
    ].join('\n'),
    'shapes.txt': [
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
      'sh1,52.0,5.0,1',
      'sh1,52.001,5.001,2',
      'sh1,52.002,5.002,3',
      'sh2,52.3,4.9,1',
      'sh2,52.301,4.901,2',
    ].join('\n'),
  });
  // A rename that names the operator, as a feed that sorts its routes by
  // agency writes it; the classifier reads the renamed id.
  const feed = {
    id: 'test-feed',
    staticRouteRename: (route) =>
      route.route_type === '2'
        ? `${route.agency_id.split(':').pop()}~${route.route_short_name}~${route.route_id}`
        : null,
    classify: (routeId) =>
      routeId?.startsWith('NS~')
        ? { category: 'national', mode: 'rail' }
        : null,
  };
  const { pack } = await buildPack(feed, zip, { url: 'x' });
  assert.deepEqual(Object.keys(pack.routes), ['NS~Intercity~114876']);

  assert.deepEqual(Object.keys(pack.trips), ['338806760']);
});
