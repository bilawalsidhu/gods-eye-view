/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
export const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('['));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};
