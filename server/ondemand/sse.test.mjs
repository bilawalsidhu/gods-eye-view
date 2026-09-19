import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pipeBinaryBody, pipeSseBody, wireAbortOnClose } from './sse.js';
import { makeReq, makeRes } from './test-helpers.mjs';

function readableFrom(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
}

describe('server/ondemand/sse.js', () => {
  test('pipeBinaryBody forwards bytes verbatim, including the [DONE] sentinel', async () => {
    const frames = [
      'event:message\ndata:{"eventType":"statusLog"}\n\n',
      'event:message\ndata:{"eventType":"fulfillment","answer":"Hi"}\n\n',
      'event:message\ndata:[DONE]\n\n',
    ];
    const upstream = readableFrom(frames);
    const res = makeRes();

    await pipeBinaryBody(upstream, res);

    assert.equal(res.text(), frames.join(''));
    assert.equal(res.ended, true);
  });

  test('pipeBinaryBody forwards an [ERROR]: sentinel verbatim (no parsing)', async () => {
    const frame = 'event:message\ndata:[ERROR]:{"message":"boom","errorCode":"model_error"}\n\n';
    const upstream = readableFrom([frame]);
    const res = makeRes();
    await pipeBinaryBody(upstream, res);
    assert.equal(res.text(), frame);
  });

  test('pipeSseBody writes a keepalive comment on the configured interval', async () => {
    let scheduled;
    let cleared = false;
    const fakeSchedule = (fn, ms) => {
      scheduled = fn;
      return 'handle';
    };
    const fakeClear = (handle) => {
      assert.equal(handle, 'handle');
      cleared = true;
    };

    // A stream that never resolves until we manually trigger the keepalive
    // and then close it, so we can deterministically observe one keepalive
    // write before the stream ends.
    let controllerRef;
    const upstream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
      },
    });
    const res = makeRes();

    const pipePromise = pipeSseBody(upstream, res, { scheduleKeepalive: fakeSchedule, clearKeepalive: fakeClear });

    // Wait a tick so pipeSseBody has registered the keepalive scheduler.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(typeof scheduled, 'function');
    scheduled(); // simulate the 15s timer firing once
    controllerRef.close();
    await pipePromise;

    assert.equal(res.text(), ':\n\n');
    assert.equal(cleared, true);
  });

  test('pipeBinaryBody always ends the sink even if the sink throws mid-stream', async () => {
    const upstream = readableFrom(['a', 'b']);
    let endCalled = false;
    const sink = {
      write() {
        throw new Error('sink is gone');
      },
      end() {
        endCalled = true;
      },
    };
    await assert.rejects(() => pipeBinaryBody(upstream, sink));
    assert.equal(endCalled, true);
  });
});

describe('wireAbortOnClose', () => {
  test('aborts the controller when the request closes, and unwires cleanly', () => {
    const req = makeReq({});
    const res = makeRes();
    const controller = new AbortController();
    const unwire = wireAbortOnClose(req, res, controller);
    assert.equal(controller.signal.aborted, false);
    req.emit('close');
    assert.equal(controller.signal.aborted, true);
    unwire(); // should not throw
  });

  test('aborts the controller when the response closes', () => {
    const req = makeReq({});
    const res = makeRes();
    const controller = new AbortController();
    wireAbortOnClose(req, res, controller);
    res.emit('close');
    assert.equal(controller.signal.aborted, true);
  });
});
