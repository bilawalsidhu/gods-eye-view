import { EventEmitter } from 'node:events';
import { radiosondesProxy } from '../../server/providers/radiosondes.js';
import { encodeRemainingLength } from '../../server/providers/sondehub/mqtt.js';

const START_MS = 1_800_000_000_000;
const settle = () => new Promise(setImmediate);

/** Exercise the production proxy with synthetic telemetry and a virtual clock. */
export function createColdRadiosondeServer(
  t,
  { mqtt = true, sse = true } = {},
) {
  let elapsed = 0,
    next = 0,
    handler,
    onTick = () => {};
  const timers = new Map(),
    requests = [],
    upstream = [];
  const schedule = (fn, delay, repeat = 0) => {
    const id = ++next;
    timers.set(id, { fn, at: elapsed + delay, repeat });
    return id;
  };
  const clock = {
    now: () => START_MS + elapsed,
    setTimeoutImpl: (fn, delay) => schedule(fn, delay),
    clearTimeoutImpl: (id) => timers.delete(id),
    setIntervalImpl: (fn, delay) => schedule(fn, delay, delay),
    clearIntervalImpl: (id) => timers.delete(id),
  };
  const row = (serial = 'RECENT123', time = clock.now()) => ({
    serial,
    datetime: time,
    time_received: time,
    lat: 50,
    lon: 10,
    alt: 15_000,
    uploader_callsign: 'PRIVATE',
    uploader_position: [1, 2],
    rssi: -12,
    snr: 42,
  });
  class Socket extends EventEmitter {
    constructor() {
      super();
      if (mqtt)
        schedule(() => {
          this.emit('open');
          this.emit('message', Buffer.from('20020000', 'hex'));
          this.emit('message', Buffer.from('9003000100', 'hex'));
          const body = Buffer.concat([
            Buffer.from([0, 5, ...Buffer.from('batch')]),
            Buffer.from(JSON.stringify([row()])),
          ]);
          this.emit(
            'message',
            Buffer.concat([
              Buffer.from([0x30]),
              encodeRemainingLength(body.length),
              body,
            ]),
          );
        }, 130);
    }
    send() {}
    terminate() {
      this.removeAllListeners();
    }
  }
  let backfillCompletedAt = null;
  const plugin = radiosondesProxy({
    ...clock,
    WebSocketImpl: Socket,
    fetchImpl(url, { signal }) {
      upstream.push({ url, atMs: elapsed });
      const discovery = url.endsWith('/websocket');
      const recent = new URL(url).searchParams.get('last') === '1800';
      return new Promise((resolve, reject) => {
        const abort = () => {
          timers.delete(id);
          reject(signal.reason);
        };
        const id = schedule(
          () => {
            signal.removeEventListener('abort', abort);
            if (!discovery && !recent) backfillCompletedAt = elapsed;
            resolve(
              discovery
                ? new Response('wss://ws-reader.v2.sondehub.org/')
                : new Response(
                    JSON.stringify(
                      recent
                        ? [row()]
                        : [row(), row('OLDER123', START_MS - 3_600_000)],
                    ),
                  ),
            );
          },
          discovery ? 20 : recent ? 200 : 6000,
        );
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  });
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  t.after(() => {
    plugin.closeBundle();
    timers.clear();
  });
  const request = (url) =>
    Object.assign(new EventEmitter(), {
      method: 'GET',
      url: url.replace('/api/radiosondes', ''),
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    });
  class Events {
    readyState = 0;
    listeners = new Map();
    constructor(url) {
      this.req = request(url);
      const self = this;
      this.res = Object.assign(new EventEmitter(), {
        writeHead() {
          self.readyState = 1;
          queueMicrotask(() => self.onopen?.());
        },
        write(chunk) {
          const match = /^event: (\w+)\ndata: (.+)\n\n$/.exec(chunk);
          if (match)
            queueMicrotask(() =>
              self.listeners.get(match[1])?.({ data: match[2] }),
            );
        },
        end() {},
        destroy() {
          self.close();
        },
      });
      void handler(this.req, this.res);
    }
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
    removeEventListener(type) {
      this.listeners.delete(type);
    }
    close() {
      this.readyState = 2;
      this.req.emit('close');
    }
  }
  return {
    ...clock,
    EventSourceImpl: sse ? Events : null,
    async fetchImpl(url, { signal }) {
      signal?.throwIfAborted();
      const entry = { atMs: elapsed };
      requests.push(entry);
      let answer;
      const res = {
        writeHead(status, headers) {
          entry.status = status;
          this.headers = headers;
        },
        end(body) {
          answer = new Response(body, {
            status: entry.status,
            headers: this.headers,
          });
        },
      };
      await handler(request(url), res);
      signal?.throwIfAborted();
      return answer;
    },
    onTick(fn) {
      onTick = fn;
    },
    elapsed: () => elapsed,
    requests,
    upstream,
    backfillCompletedAt: () => backfillCompletedAt,
    async advance(ms) {
      const end = elapsed + ms;
      await settle();
      for (;;) {
        const candidate = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!candidate) break;
        const [id, timer] = candidate;
        elapsed = timer.at;
        onTick(clock.now());
        if (timer.repeat) timer.at += timer.repeat;
        else timers.delete(id);
        timer.fn();
        await settle();
      }
      elapsed = end;
      onTick(clock.now());
      await settle();
    },
  };
}
