import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { readRequestBody } from './request.js';

function fixture() {
  const req = new EventEmitter();
  req.pause = () => assert.fail('The reader must keep draining');
  req.destroy = () =>
    assert.fail('The reader must preserve the response socket');
  const owner = new AbortController();
  return { req, owner };
}

function finish(req, owner) {
  assert.doesNotThrow(() => req.emit('error', new Error('late stream error')));
  req.emit('end');
  assert.doesNotThrow(() => req.emit('error', new Error('error before close')));
  req.emit('close');
  for (const event of ['data', 'end', 'error', 'close'])
    assert.equal(req.listenerCount(event), 0, event);
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
}

test('default and cancellable readers preserve byte caps and UTF-8 across chunks', async () => {
  for (const useSignal of [false, true]) {
    for (const text of ['', 'hello', 'é']) {
      const { req, owner } = fixture();
      const bytes = Buffer.from(text);
      const body = readRequestBody(
        req,
        bytes.length,
        useSignal ? owner.signal : undefined,
      );
      for (const byte of bytes) req.emit('data', Buffer.from([byte]));
      req.emit('end');
      assert.equal(await body, text);
      if (useSignal) finish(req, owner);
    }
  }
});

test('default overflow rejects before end and drains without pausing or destroying', async () => {
  const { req } = fixture();
  const rejection = assert.rejects(readRequestBody(req, 2), {
    code: 'BODY_TOO_LARGE',
  });
  req.emit('data', Buffer.from('é'));
  req.emit('data', Buffer.from('!'));
  await rejection;
  req.emit('data', Buffer.alloc(4096));
  assert.doesNotThrow(() => req.emit('error', new Error('late')));
  req.emit('end');
});

test('partial abort settles before end, discards late data and guards errors until close', async () => {
  const { req, owner } = fixture();
  const reason = new Error('request deadline');
  const rejection = assert.rejects(
    readRequestBody(req, 1024, owner.signal),
    (error) => error === reason,
  );
  req.emit('data', Buffer.from('partial'));
  owner.abort(reason);
  await rejection;
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
  req.emit('data', Buffer.alloc(4096));
  finish(req, owner);
});

test('already-aborted and already-closed requests settle and release their listeners', async () => {
  for (const closed of [false, true]) {
    const { req, owner } = fixture();
    if (closed) req.destroyed = true;
    else owner.abort();
    await assert.rejects(readRequestBody(req, 1024, owner.signal), {
      name: 'AbortError',
    });
    if (!closed) finish(req, owner);
    for (const event of ['data', 'end', 'error', 'close'])
      assert.equal(req.listenerCount(event), 0);
    assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
  }
});

test('overflow keeps its first failure through later abort and stream errors', async () => {
  const { req, owner } = fixture();
  const rejection = assert.rejects(readRequestBody(req, 2, owner.signal), {
    code: 'BODY_TOO_LARGE',
  });
  req.emit('data', Buffer.from('é!'));
  await rejection;
  owner.abort(new Error('later deadline'));
  req.emit('data', Buffer.alloc(4096));
  finish(req, owner);
});

test('early close and request error reject once; successful end wins over later abort', async () => {
  for (const event of ['close', 'error', 'end']) {
    const { req, owner } = fixture();
    const reason = new Error('request failed');
    const body = readRequestBody(req, 32, owner.signal);
    const observed =
      event === 'end'
        ? body.then((value) => assert.equal(value, 'ok'))
        : assert.rejects(
            body,
            event === 'close'
              ? { name: 'AbortError' }
              : (error) => error === reason,
          );
    req.emit('data', Buffer.from('ok'));
    req.emit(event, reason);
    owner.abort(new Error('later abort'));
    await observed;
    if (event !== 'close') finish(req, owner);
    assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
  }
});

test('a prior data observer can abort synchronously without retaining or resolving that chunk', async () => {
  const { req, owner } = fixture();
  const reason = new Error('observer stopped request');
  const external = () => owner.abort(reason);
  req.on('data', external);
  const rejection = assert.rejects(
    readRequestBody(req, 1024, owner.signal),
    (error) => error === reason,
  );
  req.emit('data', Buffer.from('must be discarded'));
  await rejection;
  req.emit('end');
  req.emit('close');
  assert.deepEqual(req.listeners('data'), [external]);
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
  req.off('data', external);
});
