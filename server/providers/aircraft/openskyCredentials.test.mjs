import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openSkyClientCredentials } from './opensky.js';

const file = (contents) => (filePath) => {
  file.read = filePath;
  if (contents instanceof Error) throw contents;
  return contents;
};

test('OpenSky client env vars come first', () => {
  const read = () => assert.fail('the file is not read when env vars are set');
  assert.deepEqual(
    openSkyClientCredentials(
      {
        OPENSKY_CLIENT_ID: ' id ',
        OPENSKY_CLIENT_SECRET: 'secret',
        OPENSKY_CREDENTIALS_FILE: 'credentials.json',
      },
      read,
    ),
    { clientId: 'id', clientSecret: 'secret' },
  );
});

test('OPENSKY_CREDENTIALS_FILE supplies the client when env vars are empty', () => {
  const env = {
    OPENSKY_CLIENT_ID: '',
    OPENSKY_CREDENTIALS_FILE: '~/Downloads/credentials.json',
  };
  // The file OpenSky's account page downloads uses camelCase keys.
  assert.deepEqual(
    openSkyClientCredentials(
      env,
      file('{"clientId":"cid","clientSecret":"csecret"}'),
    ),
    { clientId: 'cid', clientSecret: 'csecret' },
  );
  assert.equal(
    path.normalize(file.read),
    path.normalize(path.join(os.homedir(), 'Downloads/credentials.json')),
  );
  assert.deepEqual(
    openSkyClientCredentials(
      env,
      file('{"client_id":"cid","client_secret":"csecret"}'),
    ),
    { clientId: 'cid', clientSecret: 'csecret' },
  );
});

test('a missing, unreadable or incomplete credentials file means no client', () => {
  assert.equal(openSkyClientCredentials({}, file('{}')), null);
  const env = { OPENSKY_CREDENTIALS_FILE: 'credentials.json' };
  const missing = Object.assign(new Error('nope'), { code: 'ENOENT' });
  assert.equal(openSkyClientCredentials(env, file(missing)), null);
  assert.equal(openSkyClientCredentials(env, file('not json')), null);
  assert.equal(openSkyClientCredentials(env, file('{"clientId":"cid"}')), null);
});
