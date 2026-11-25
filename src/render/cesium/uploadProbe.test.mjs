import assert from 'node:assert/strict';
import test from 'node:test';
import { countDrawSetUploads } from './uploadProbe.js';

/** A scene whose context counts nothing itself, and hosts that upload. */
function sceneWith(hosts) {
  const gl = {
    bufferData() {},
    bufferSubData() {},
  };
  const scene = {
    context: { _gl: gl },
    primitives: {
      get: (i) => hosts[i],
      get length() {
        return hosts.length;
      },
    },
  };
  return { scene, gl };
}

function uploader(gl, drawSetId, bytes) {
  return {
    drawSetId,
    update() {
      gl.bufferData(0, new Float32Array(bytes / 4), 0);
      gl.bufferSubData(0, 0, new Uint8Array(bytes), 2, 3);
    },
  };
}

test('only the named sets’ uploads count, from each reset, and stop gives everything back', () => {
  const hosts = [];
  const { scene, gl } = sceneWith(hosts);
  const ownBufferData = gl.bufferData;
  const mine = uploader(gl, 'transit:1:still', 16);
  const other = uploader(gl, 'traffic:1', 64);
  hosts.push(mine, other);
  const ownUpdate = mine.update;
  const uploads = countDrawSetUploads({ scene }, [
    'transit:1:still',
    'transit:1:moving',
  ]);
  uploads.reset();
  mine.update();
  other.update();
  // 16 bytes of data, then 3 of the 16-byte view from element 2.
  assert.equal(uploads.bytes(), 16 + 3);
  // A host that comes later (a rebuild) is found at the next reset.
  const later = uploader(gl, 'transit:1:moving', 8);
  const laterUpdate = later.update;
  hosts.push(later);
  uploads.reset();
  assert.equal(uploads.bytes(), 0);
  later.update();
  assert.equal(uploads.bytes(), 8 + 3);
  // An update replaced while counting is the one kept.
  const replaced = function () {};
  mine.update = replaced;
  uploads.stop();
  assert.equal(gl.bufferData, ownBufferData);
  assert.equal(later.update, laterUpdate, 'its own update back');
  assert.equal(mine.update, replaced, 'an update replaced meanwhile stays');
  assert.notEqual(mine.update, ownUpdate);
  // Nothing counts once stopped.
  later.update();
  assert.equal(uploads.bytes(), 8 + 3);
});

test('an inherited update is given back by removing the wrapper', () => {
  const hosts = [];
  const { scene, gl } = sceneWith(hosts);
  class Host {
    update() {
      gl.bufferData(0, 4, 0);
    }
  }
  const host = Object.assign(new Host(), { drawSetId: 's' });
  hosts.push(host);
  const uploads = countDrawSetUploads({ scene }, ['s']);
  assert.ok(Object.hasOwn(host, 'update'));
  uploads.reset();
  host.update();
  assert.equal(uploads.bytes(), 4);
  uploads.stop();
  assert.equal(Object.hasOwn(host, 'update'), false);
  assert.equal(host.update, Host.prototype.update);
});

test('a size-only allocation counts its size', () => {
  const hosts = [];
  const { scene, gl } = sceneWith(hosts);
  hosts.push({
    drawSetId: 's',
    update() {
      gl.bufferData(0, 100, 0);
    },
  });
  const uploads = countDrawSetUploads({ scene }, ['s']);
  uploads.reset();
  hosts[0].update();
  assert.equal(uploads.bytes(), 100);
  uploads.stop();
});
