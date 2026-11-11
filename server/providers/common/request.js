/** Read a request body with a hard byte cap; throws { code:'BODY_TOO_LARGE' } past the cap. */
async function readRequestBodyCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Optional cancellation discards buffered data while the request drains. */
function readRequestBody(req, maxBytes = 1024 * 1024, signal) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let bodyTooLarge = false;
    let settled = false;
    const chunks = [];
    const stopReading = () => {
      if (!signal) return;
      req.off('data', data);
      req.off('end', end);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error) => {
      if (signal) {
        if (settled) return;
        settled = true;
        chunks.length = 0;
        signal.removeEventListener('abort', abort);
      }
      reject(error);
    };
    const abort = () => fail(signal.reason);
    const data = (chunk) => {
      // Keep draining after the cap without retaining more bytes. Destroying
      // the request also destroys its socket, so the handler cannot deliver
      // the fixed error response it constructs for BODY_TOO_LARGE.
      if (bodyTooLarge || settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Same marker readRequestBodyCapped sets, so a caller can tell an
        // oversized body from a genuine failure without matching on text.
        bodyTooLarge = true;
        chunks.length = 0;
        const error = new Error(`Request body exceeds ${maxBytes} bytes`);
        error.code = 'BODY_TOO_LARGE';
        fail(error);
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      if (settled) {
        stopReading();
        return;
      }
      if (!bodyTooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
      if (signal) {
        settled = true;
        chunks.length = 0;
        stopReading();
      }
    };
    const close = () => {
      fail(
        new DOMException('Request closed before its body ended', 'AbortError'),
      );
      stopReading();
      req.off('error', fail);
      req.off('close', close);
    };
    if (signal) {
      // Abort/overflow release retained bytes but keep draining. Retain an
      // error handler until close, including a late error after end/abort.
      req.on('close', close);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    req.on('data', data);
    req.on('end', end);
    req.on('error', fail);
    if (signal && req.destroyed) close();
  });
}

export { readRequestBodyCapped, readRequestBody };
