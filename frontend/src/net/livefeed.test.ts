/**
 * Tests for the reconnecting socket, against a fake `WebSocket` and fake timers.
 *
 * This is the half of the socket client that only runs when something has gone wrong, so
 * it is the half least likely to be exercised by hand and most likely to be broken when it
 * is needed. A frozen globe that never says it is frozen is the worst outcome this app
 * has, and every assertion below is about not producing one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveFeed, RECONNECT_BASE_MS, liveFeedUrl } from './ws';
import type { Batch, ConnectionState } from './ws';

/**
 * What the browser globals recorded during one test.
 *
 * Held in a const container and emptied in place between tests, so nothing reassigns a
 * top-level binding from inside a hook.
 */
const recorded: { opened: FakeSocket[]; frames: (() => void)[] } = { opened: [], frames: [] };

class FakeSocket {
  readonly url: string;
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    recorded.opened.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  /** Drive the socket from the far end, the way a real one would be driven. */
  emit(type: string, event: unknown = {}): void {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function harness() {
  const states: { state: ConnectionState; retryInMs: number | null }[] = [];
  const applied: Batch[] = [];
  const feed = new LiveFeed({
    url: 'ws://localhost/ws',
    apply: (batch) => {
      applied.push(batch);
    },
    onState: (state, retryInMs) => {
      states.push({ state, retryInMs });
    },
  });
  return { feed, states, applied };
}

/** The socket the feed most recently opened. */
function latest(): FakeSocket {
  const socket = recorded.opened.at(-1);
  if (socket === undefined) {
    throw new Error('no socket was opened');
  }
  return socket;
}

/** Run whatever the batcher asked for, so no test waits on a real animation frame. */
function runFrame(): void {
  const queued = [...recorded.frames];
  recorded.frames.length = 0;
  for (const frame of queued) {
    frame();
  }
}

beforeEach(() => {
  recorded.opened.length = 0;
  recorded.frames.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('requestAnimationFrame', (frame: () => void) => {
    recorded.frames.push(frame);
    return recorded.frames.length;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('liveFeedUrl', () => {
  it('follows the page onto plain ws', () => {
    expect(liveFeedUrl({ protocol: 'http:', host: 'localhost:5173' } as Location)).toBe(
      'ws://localhost:5173/ws',
    );
  });

  it('upgrades to wss on a secure page, or the browser blocks the connection', () => {
    expect(liveFeedUrl({ protocol: 'https:', host: 'tracker.example' } as Location)).toBe(
      'wss://tracker.example/ws',
    );
  });
});

describe('LiveFeed.start', () => {
  it('opens the socket it was given and says it is connecting', () => {
    const { feed, states } = harness();

    feed.start();

    expect(recorded.opened).toHaveLength(1);
    expect(latest().url).toBe('ws://localhost/ws');
    expect(states).toEqual([{ state: 'connecting', retryInMs: null }]);
  });

  it('reports live once the socket opens', () => {
    const { feed, states } = harness();
    feed.start();

    latest().emit('open');

    expect(states.at(-1)).toEqual({ state: 'live', retryInMs: null });
  });
});

describe('LiveFeed message handling', () => {
  it('applies a parsed message on the next frame, not the instant it lands', () => {
    const { feed, applied } = harness();
    feed.start();
    latest().emit('open');

    latest().emit('message', {
      data: '{"type":"remove","layer":"aircraft","ids":["aaaaaa"],"server_time":"2026-08-19T12:00:00Z"}',
    });

    expect(applied).toHaveLength(0);
    runFrame();

    expect(applied).toHaveLength(1);
    expect(applied[0]?.removals.get('aaaaaa')).toBe('aircraft');
  });

  it('coalesces a burst of messages into one application', () => {
    const { feed, applied } = harness();
    feed.start();
    latest().emit('open');

    for (const id of ['aaaaaa', 'bbbbbb', 'cccccc']) {
      latest().emit('message', {
        data: `{"type":"remove","layer":"aircraft","ids":["${id}"],"server_time":"2026-08-19T12:00:00Z"}`,
      });
    }
    runFrame();

    // Three messages, one frame, one application. This is what stops the jank.
    expect(applied).toHaveLength(1);
    expect(applied[0]?.removals.size).toBe(3);
  });

  it('drops a frame that is not text, because the server only ever sends JSON', () => {
    const { feed, applied } = harness();
    feed.start();
    latest().emit('open');

    latest().emit('message', { data: new ArrayBuffer(8) });
    latest().emit('message', { data: 'not json at all' });
    runFrame();

    expect(applied).toHaveLength(0);
  });
});

describe('LiveFeed reconnection', () => {
  it('closes the socket on an error and lets the close handler retry', () => {
    const { feed } = harness();
    feed.start();
    const socket = latest();

    socket.emit('error');

    expect(socket.closed).toBe(true);
  });

  it('says how long it will wait, rather than going quiet', () => {
    const { feed, states } = harness();
    feed.start();
    latest().emit('open');

    latest().emit('close');

    const last = states.at(-1);
    expect(last?.state).toBe('reconnecting');
    // Jittered between half and all of the base delay.
    expect(last?.retryInMs).toBeGreaterThanOrEqual(RECONNECT_BASE_MS / 2);
    expect(last?.retryInMs).toBeLessThanOrEqual(RECONNECT_BASE_MS);
  });

  it('opens a new socket once the delay has elapsed', () => {
    const { feed } = harness();
    feed.start();
    latest().emit('close');

    vi.advanceTimersByTime(RECONNECT_BASE_MS);

    expect(recorded.opened).toHaveLength(2);
  });

  it('backs off further on each successive failure', () => {
    const { feed, states } = harness();
    feed.start();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      latest().emit('close');
      const retry = states.at(-1)?.retryInMs;
      delays.push(retry ?? 0);
      vi.advanceTimersByTime(retry ?? 0);
    }

    // Each wait at least doubles, so a server that is down is not hammered.
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThan(delays[index - 1] ?? 0);
    }
  });

  it('resets the backoff after a successful connection', () => {
    const { feed, states } = harness();
    feed.start();

    latest().emit('close');
    const first = states.at(-1)?.retryInMs ?? 0;
    vi.advanceTimersByTime(first);
    latest().emit('open');
    latest().emit('close');
    const afterSuccess = states.at(-1)?.retryInMs ?? 0;

    // A connection that dropped once an hour must not inherit an hour-long backoff.
    expect(afterSuccess).toBeLessThanOrEqual(RECONNECT_BASE_MS);
  });

  it('calls a reconnect attempt "reconnecting", not "connecting"', () => {
    const { feed, states } = harness();
    feed.start();
    latest().emit('close');
    const before = states.length;

    vi.advanceTimersByTime(RECONNECT_BASE_MS);

    expect(states[before]?.state).toBe('reconnecting');
  });
});

describe('LiveFeed.stop', () => {
  it('closes the socket and says so', () => {
    const { feed, states } = harness();
    feed.start();
    const socket = latest();

    feed.stop();

    expect(socket.closed).toBe(true);
    expect(states.at(-1)).toEqual({ state: 'closed', retryInMs: null });
  });

  it('does not reconnect after being stopped', () => {
    const { feed } = harness();
    feed.start();
    const socket = latest();

    feed.stop();
    socket.emit('close');
    vi.advanceTimersByTime(60_000);

    expect(recorded.opened).toHaveLength(1);
  });

  it('cancels a retry that was already pending', () => {
    const { feed } = harness();
    feed.start();
    latest().emit('close');

    feed.stop();
    vi.advanceTimersByTime(60_000);

    expect(recorded.opened).toHaveLength(1);
  });

  it('can be started again after being stopped', () => {
    const { feed } = harness();
    feed.start();
    feed.stop();

    feed.start();

    expect(recorded.opened).toHaveLength(2);
  });
});
