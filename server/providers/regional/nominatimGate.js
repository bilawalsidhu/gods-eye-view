import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readResponseJsonCapped } from '../common/http.js';

/**
 * One gate for every request this server sends to a Nominatim instance.
 *
 * Place search and voice outlines share it. Public requests reserve one start
 * at a time across processes sharing this installation's state file, remain at
 * least 1.1 s apart, use a short queue and daily ceiling, and pause after the
 * server says to stop. Independent installations do not share one app-wide
 * limiter; each must identify itself and enforce the public policy locally.
 */

/** The public instance. Only this host is subject to the public-use limits. */
export const PUBLIC_NOMINATIM_SEARCH =
  'https://nominatim.openstreetmap.org/search';

const PUBLIC_NOMINATIM_HOST = 'nominatim.openstreetmap.org';

/**
 * The public usage policy asks for a User-Agent or Referer that identifies the
 * application. The identity is stable: it is never rotated or varied.
 */
export const NOMINATIM_HEADERS = Object.freeze({
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
  Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
});

/** Absolute policy maximum is one request per second; 1.1 s absorbs jitter. */
export const NOMINATIM_MIN_SPACING_MS = 1100;

/** Requests allowed to wait for their turn; past this, refuse at once. */
export const NOMINATIM_MAX_PENDING = 4;

/** A queued request older than this has no reader left; drop it unsent. */
export const NOMINATIM_MAX_WAIT_MS = 10_000;

/** Default public requests per install per UTC day, outlines and search together. */
export const NOMINATIM_DEFAULT_DAILY_CAP = 50;

/**
 * Pause after a refusal without Retry-After. A Retry-After from the server is
 * honoured in full, however long: no local maximum may cause an earlier retry.
 */
const DEFAULT_BACKOFF_MS = 60_000;
/** A 403 from the public instance means this identity is blocked: stop longer. */
const BLOCKED_BACKOFF_MS = 3_600_000;
/** Pause after a server error or a failed retry. */
const OUTAGE_BACKOFF_MS = 30_000;

const DISABLED_VALUES = new Set(['', 'off', 'none', 'disabled', '0']);

/**
 * Read the search endpoint setting.
 *
 * Unset means the public instance under its guards. Set to empty (or `off`)
 * disables every Nominatim request. Any other value must be an http(s) URL
 * without credentials, query or fragment; a bare host gets `/search`. A value
 * that is not usable disables the service rather than falling back to the
 * public instance.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{endpoint: string|null, isPublic: boolean, dailyCap: number, invalid?: boolean}}
 */
export function resolveNominatimSettings(env = process.env) {
  const dailyCap = parseDailyCap(env.NOMINATIM_DAILY_CAP);
  const raw = env.NOMINATIM_URL;
  if (raw === undefined)
    return { endpoint: PUBLIC_NOMINATIM_SEARCH, isPublic: true, dailyCap };
  const value = String(raw).trim();
  if (DISABLED_VALUES.has(value.toLowerCase()))
    return { endpoint: null, isPublic: false, dailyCap };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { endpoint: null, isPublic: false, dailyCap, invalid: true };
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return { endpoint: null, isPublic: false, dailyCap, invalid: true };
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/search';
  return {
    endpoint: url.href.replace(/\/$/, ''),
    // A trailing DNS dot names the same host.
    isPublic:
      url.hostname.toLowerCase().replace(/\.$/, '') === PUBLIC_NOMINATIM_HOST,
    dailyCap,
  };
}

function parseDailyCap(raw) {
  if (raw === undefined || String(raw).trim() === '')
    return NOMINATIM_DEFAULT_DAILY_CAP;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : NOMINATIM_DEFAULT_DAILY_CAP;
}

function gateError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const HTTP_MONTHS = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);
const HTTP_WEEKDAYS = Object.freeze([
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
]);
const HTTP_WEEKDAYS_LONG = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

/** Strict RFC 9110 HTTP-date, including the two obsolete recipient formats. */
function parseHttpDate(raw, now) {
  let match = raw.match(
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/,
  );
  let weekday, day, month, year, hour, minute, second;
  if (match) {
    [, weekday, day, month, year, hour, minute, second] = match;
    weekday = HTTP_WEEKDAYS.indexOf(weekday);
  } else {
    match = raw.match(
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/,
    );
    if (match) {
      [, weekday, day, month, year, hour, minute, second] = match;
      weekday = HTTP_WEEKDAYS_LONG.indexOf(weekday);
      const currentYear = new Date(now).getUTCFullYear();
      if (!Number.isFinite(currentYear)) return null;
      year = Math.floor(currentYear / 100) * 100 + Number(year);
      if (year > currentYear + 50) year -= 100;
    } else {
      match = raw.match(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/,
      );
      if (!match) return null;
      [, weekday, month, day, hour, minute, second, year] = match;
      weekday = HTTP_WEEKDAYS.indexOf(weekday);
    }
  }
  day = Number(day);
  month = HTTP_MONTHS.indexOf(month);
  year = Number(year);
  hour = Number(hour);
  minute = Number(minute);
  second = Number(second);
  if (
    weekday < 0 ||
    month < 0 ||
    year < 1601 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const at = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(at);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCDay() === weekday
    ? at
    : null;
}

/** Seconds or an HTTP date → milliseconds from now, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  // Numeric-looking but invalid delay-seconds must not be reinterpreted as a date.
  if (/^[+-]?(?:\d|\.\d)/.test(raw)) return null;
  const at = parseHttpDate(raw, now);
  return at === null ? null : Math.max(0, at - now);
}

/** UTC calendar day, the unit of the daily cap. */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Public-service state shared by every process using the same file: today's
 * request count, the next reserved start, and any pause the server asked for.
 *
 * Every change is a read-modify-write under an OS-owned SQLite transaction,
 * and the JSON file is replaced atomically, so two dev servers sharing a
 * checkout add to one count instead of overwriting each other. A process exit
 * releases only that process's transaction; there is no stale path to delete
 * and therefore no stale reclaimer that can remove a successor's live lock.
 * Memory keeps the highest values this process has seen, so a failed or
 * unreadable file never lowers the count or shortens a pause; a persistence
 * failure is reported once and in `status()`.
 */
export function createGateStateStore({
  file = null,
  lockWaitMs = 500,
  onError = (error) =>
    console.warn(
      `[Nominatim] could not persist usage state: ${error?.message || error}`,
    ),
} = {}) {
  let memory = { day: '', count: 0, pausedUntil: 0, nextStartAt: 0 };
  let lastError = null;

  const report = (error) => {
    if (!lastError) onError(error);
    lastError = error;
  };

  const pauseMarkerPrefix = file ? `${path.basename(file)}.pause.` : null;

  /**
   * A refusal must remain visible even while another process owns the SQLite
   * transaction. Immutable marker names make that write atomic and monotonic:
   * concurrent writers cannot shorten one another's pause, and the next lock
   * owner folds every marker into the normal JSON state.
   */
  function pendingPauses({ strict = false } = {}) {
    if (!file) return [];
    let names;
    try {
      names = fs.readdirSync(path.dirname(file));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      report(error);
      if (strict) throw error;
      return [];
    }
    const pauses = [];
    for (const name of names) {
      if (!name.startsWith(pauseMarkerPrefix)) continue;
      const encoded = name.slice(pauseMarkerPrefix.length).split('.', 1)[0];
      if (!/^\d+$/.test(encoded)) continue;
      const pausedUntil = Number(encoded);
      if (!Number.isSafeInteger(pausedUntil)) {
        const error = new Error('invalid durable Nominatim pause marker');
        report(error);
        if (strict) throw error;
        continue;
      }
      pauses.push({
        path: path.join(path.dirname(file), name),
        pausedUntil,
      });
    }
    return pauses;
  }

  function markPause(at) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pausedUntil = Math.ceil(at);
    const marker = `${file}.pause.${pausedUntil}.${process.pid}.${process.hrtime.bigint()}`;
    fs.writeFileSync(marker, '', { flag: 'wx' });
    return pausedUntil;
  }

  function clearPersistedPauses(pausedUntil) {
    for (const marker of pendingPauses()) {
      if (marker.pausedUntil > pausedUntil) continue;
      try {
        fs.unlinkSync(marker.path);
      } catch (error) {
        if (error?.code !== 'ENOENT') report(error);
      }
    }
  }

  const merge = (a, b) => ({
    day: a.day >= b.day ? a.day : b.day,
    count:
      a.day === b.day
        ? Math.max(a.count, b.count)
        : a.day > b.day
          ? a.count
          : b.count,
    pausedUntil: Math.max(a.pausedUntil || 0, b.pausedUntil || 0),
    nextStartAt: Math.max(a.nextStartAt || 0, b.nextStartAt || 0),
  });

  const parseState = (parsed) => {
    const validDay =
      parsed?.day === '' ||
      (typeof parsed?.day === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.day) &&
        new Date(`${parsed.day}T00:00:00.000Z`)
          .toISOString()
          .startsWith(parsed.day));
    const validCount =
      Number.isInteger(parsed?.count) &&
      parsed.count >= 0 &&
      (parsed.day !== '' || parsed.count === 0);
    const validPausedUntil =
      Number.isFinite(parsed?.pausedUntil) && parsed.pausedUntil >= 0;
    // nextStartAt was added after the original state format. Its absence is
    // the one supported migration; a present value must still be trustworthy.
    const validNextStartAt =
      parsed?.nextStartAt === undefined ||
      (Number.isFinite(parsed.nextStartAt) && parsed.nextStartAt >= 0);
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== 'object' ||
      !validDay ||
      !validCount ||
      !validPausedUntil ||
      !validNextStartAt
    )
      throw new Error('invalid durable Nominatim usage state');
    return {
      day: parsed.day,
      count: parsed.count,
      pausedUntil: parsed.pausedUntil,
      nextStartAt: parsed.nextStartAt ?? 0,
    };
  };

  function readDisk({ strict = false } = {}) {
    if (!file) {
      if (strict)
        throw new Error('no durable Nominatim usage state is configured');
      return null;
    }
    try {
      return parseState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      report(error);
      if (strict) throw error;
      return null;
    }
  }

  function current() {
    const disk = readDisk();
    if (disk) memory = merge(memory, disk);
    const pending = pendingPauses();
    if (pending.length)
      memory = merge(memory, {
        ...memory,
        pausedUntil: Math.max(...pending.map((item) => item.pausedUntil)),
      });
    return memory;
  }

  function withLock(work) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const waitMs = Number.isFinite(lockWaitMs)
      ? Math.max(0, Math.floor(lockWaitMs))
      : 500;
    const database = new DatabaseSync(`${file}.lock.sqlite`, {
      timeout: waitMs,
    });
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const result = work();
      database.exec('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Closing the connection below still releases this owner's lock.
        }
      }
      throw error;
    } finally {
      try {
        database.close();
      } catch {
        // The transaction has already been committed or rolled back. Closing
        // is best effort during exceptional teardown and never removes a lock.
      }
    }
  }

  function writeDisk(next) {
    const temp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next));
      fs.renameSync(temp, file);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch (error) {
        if (error?.code !== 'ENOENT') report(error);
      }
    }
  }

  /** Apply `change` to the freshest state and persist it atomically. */
  function update(change) {
    if (!file) {
      memory = merge(memory, change(memory));
      return memory;
    }
    try {
      withLock(() => {
        const next = merge(memory, change(current()));
        writeDisk(next);
        memory = next;
        clearPersistedPauses(next.pausedUntil);
        lastError = null;
      });
    } catch (error) {
      report(error);
      memory = merge(memory, change(memory));
    }
    return memory;
  }

  return {
    count(day) {
      const state = current();
      return state.day === day ? state.count : 0;
    },
    increment(day) {
      return update((state) => ({
        day,
        count: state.day === day ? state.count + 1 : 1,
        pausedUntil: state.pausedUntil,
        nextStartAt: state.nextStartAt,
      })).count;
    },
    reserve(day, { now, dailyCap, minSpacingMs, latestStartAt = Infinity }) {
      if (!file) {
        const error = new Error(
          'no durable Nominatim usage state is configured',
        );
        report(error);
        return { status: 'unavailable', error };
      }
      try {
        let result;
        withLock(() => {
          const disk = readDisk({ strict: true });
          if (disk) memory = merge(memory, disk);
          const pending = pendingPauses({ strict: true });
          if (pending.length)
            memory = merge(memory, {
              ...memory,
              pausedUntil: Math.max(...pending.map((item) => item.pausedUntil)),
            });
          const state = memory;
          if ((state.pausedUntil || 0) > now) {
            result = {
              status: 'paused',
              retryAfterMs: state.pausedUntil - now,
            };
            return;
          }
          const count = state.day === day ? state.count : 0;
          if (count >= dailyCap) {
            result = { status: 'cap' };
            return;
          }
          const startAt = Math.max(now, state.nextStartAt || 0);
          if (startAt > latestStartAt) {
            result = { status: 'abandoned' };
            return;
          }
          const next = {
            day,
            count: count + 1,
            pausedUntil: state.pausedUntil || 0,
            nextStartAt: startAt + minSpacingMs,
          };
          writeDisk(next);
          memory = next;
          clearPersistedPauses(next.pausedUntil);
          lastError = null;
          result = { status: 'reserved', startAt, count: next.count };
        });
        return result;
      } catch (error) {
        report(error);
        return { status: 'unavailable', error };
      }
    },
    pausedUntil() {
      return current().pausedUntil || 0;
    },
    pauseUntil(at) {
      if (file) {
        try {
          at = markPause(at);
        } catch (error) {
          report(error);
        }
      }
      update((state) => ({ ...state, pausedUntil: at }));
    },
    status: () => ({
      file,
      durable: Boolean(file),
      persisted: Boolean(file) && !lastError,
      error: lastError ? String(lastError.message || lastError) : null,
    }),
  };
}

/** Compatibility name for the state store. */
export const createUsageStore = createGateStateStore;

/**
 * Construct a gate. `settings` may be a function so the environment is read
 * after the dev server loads `.env`.
 *
 * @param {object} [options]
 * @param {(() => object)|object} [options.settings]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {ReturnType<typeof createUsageStore>} [options.usage]
 */
export function createNominatimGate({
  settings = () => resolveNominatimSettings(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  usage = createGateStateStore(),
  minSpacingMs = NOMINATIM_MIN_SPACING_MS,
  maxPending = NOMINATIM_MAX_PENDING,
  maxWaitMs = NOMINATIM_MAX_WAIT_MS,
  timeoutMs = 9000,
} = {}) {
  let queue = Promise.resolve();
  let pending = 0;
  const pausedUntilByEndpoint = new Map();
  let upstreamRequests = 0;
  let usageStore = usage;

  const current = () =>
    typeof settings === 'function' ? settings() : settings;

  /**
   * Pause until `ms` from now. The public service's pause is also written to
   * the shared state so a restart or a second process honours it.
   */
  function pause(ms, config) {
    const until = now() + Math.max(0, ms);
    const key = String(config?.endpoint || '');
    if (until > (pausedUntilByEndpoint.get(key) || 0))
      pausedUntilByEndpoint.set(key, until);
    if (config?.isPublic) usageStore.pauseUntil(until);
  }

  function pauseEnd(config) {
    const endpointPause =
      pausedUntilByEndpoint.get(String(config?.endpoint || '')) || 0;
    return config?.isPublic
      ? Math.max(endpointPause, usageStore.pausedUntil())
      : endpointPause;
  }

  function pausedError(config) {
    return gateError('NOMINATIM_PAUSED', 'Place service is pausing', {
      retryAfterMs: Math.max(0, pauseEnd(config) - now()),
    });
  }

  function admissionError(config) {
    if (!config.endpoint)
      return gateError('NOMINATIM_DISABLED', 'Place service is not configured');
    if (now() < pauseEnd(config)) return pausedError(config);
    return null;
  }

  /** One upstream request; classifies refusals and pauses the gate. */
  async function send(url, config, maxBytes, signal) {
    upstreamRequests += 1;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    // One deadline covers the headers AND the body: a server that answers its
    // headers and then stalls must not hold the shared queue.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await exchange(url, config, maxBytes, signal, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function exchange(url, config, maxBytes, signal, requestSignal) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: NOMINATIM_HEADERS,
        redirect: 'error',
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal?.aborted) throw gateError('NOMINATIM_ABANDONED', 'Abandoned');
      throw gateError('NOMINATIM_TRANSPORT', 'Place service unreachable', {
        cause,
        transport: true,
      });
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      const status = response.status;
      const retryAfter = parseRetryAfter(
        response.headers?.get?.('retry-after'),
        now(),
      );
      if (status === 429 || status === 503) {
        pause(retryAfter ?? DEFAULT_BACKOFF_MS, config);
        throw gateError('NOMINATIM_REFUSED', 'Place service asked to wait', {
          status,
          retryAfterMs: Math.max(0, pauseEnd(config) - now()),
        });
      }
      if (status === 403 || status === 418) {
        pause(retryAfter ?? BLOCKED_BACKOFF_MS, config);
        throw gateError('NOMINATIM_REFUSED', 'Place service refused', {
          status,
          retryAfterMs: Math.max(0, pauseEnd(config) - now()),
        });
      }
      if (status >= 500) pause(retryAfter ?? OUTAGE_BACKOFF_MS, config);
      throw gateError('NOMINATIM_UPSTREAM', `Upstream returned ${status}`, {
        status,
      });
    }
    try {
      return await readResponseJsonCapped(response, maxBytes, requestSignal);
    } catch (cause) {
      if (cause?.code === 'RESPONSE_TOO_LARGE')
        throw gateError('NOMINATIM_TOO_LARGE', 'Place answer too large');
      if (signal?.aborted) throw gateError('NOMINATIM_ABANDONED', 'Abandoned');
      throw gateError('NOMINATIM_TRANSPORT', 'Place answer unreadable', {
        cause,
        transport: true,
      });
    }
  }

  /** Atomically reserve the public slot, then wait until it may start. */
  async function takeTurn(config, queuedAt, signal) {
    if (signal?.aborted || now() - queuedAt > maxWaitMs)
      throw gateError('NOMINATIM_ABANDONED', 'Place search was abandoned');
    const refused = admissionError(config);
    if (refused) throw refused;
    // An operator-selected endpoint is not governed by the public instance's
    // shared budget, pacing, or durable-state requirement.
    if (!config.isPublic) return;
    const reserved = usageStore.reserve(utcDay(now()), {
      now: now(),
      dailyCap: config.dailyCap,
      minSpacingMs,
      latestStartAt: queuedAt + maxWaitMs,
    });
    if (reserved.status === 'unavailable')
      throw gateError(
        'NOMINATIM_STATE_UNAVAILABLE',
        'Public place service usage state is unavailable',
        { cause: reserved.error },
      );
    if (reserved.status === 'cap')
      throw gateError(
        'NOMINATIM_DAILY_CAP',
        'Daily place lookup allowance is used',
      );
    if (reserved.status === 'paused')
      throw gateError('NOMINATIM_PAUSED', 'Place service is pausing', {
        retryAfterMs: reserved.retryAfterMs,
      });
    if (reserved.status === 'abandoned')
      throw gateError('NOMINATIM_ABANDONED', 'Place search was abandoned');
    const waitMs = Math.max(0, reserved.startAt - now());
    if (waitMs) await sleep(waitMs);
    if (signal?.aborted || now() - queuedAt > maxWaitMs)
      throw gateError('NOMINATIM_ABANDONED', 'Place search was abandoned');
    // A refusal from another process after this reservation still stops it.
    // The reserved daily slot remains spent; it cannot safely be reassigned.
    if (now() < pauseEnd(config)) throw pausedError(config);
  }

  /**
   * Queue one JSON request for `buildUrl(endpoint)`. At most one retry, and
   * only after a transport failure; a failed retry pauses the gate.
   *
   * @param {(endpoint: string) => string} buildUrl
   * @param {{signal?: AbortSignal, maxBytes?: number}} [options]
   */
  function requestJson(buildUrl, { signal, maxBytes = 2 * 1024 * 1024 } = {}) {
    const config = current();
    const refused = admissionError(config);
    if (refused) return Promise.reject(refused);
    if (signal?.aborted)
      return Promise.reject(
        gateError('NOMINATIM_ABANDONED', 'Place search was abandoned'),
      );
    if (pending >= maxPending)
      return Promise.reject(
        gateError('NOMINATIM_QUEUE_FULL', 'Place search queue is full'),
      );
    pending += 1;
    const queuedAt = now();
    const url = buildUrl(config.endpoint);
    const task = queue.then(async () => {
      try {
        await takeTurn(config, queuedAt, signal);
        try {
          return await send(url, config, maxBytes, signal);
        } catch (error) {
          if (!error?.transport) throw error;
          await takeTurn(config, now(), signal);
          try {
            return await send(url, config, maxBytes, signal);
          } catch (retryError) {
            if (retryError?.transport) pause(OUTAGE_BACKOFF_MS, config);
            throw retryError;
          }
        }
      } finally {
        pending -= 1;
      }
    });
    queue = task.catch(() => null);
    return task;
  }

  return {
    requestJson,
    settings: current,
    /** Share public admission, daily count and pauses through one install's file. */
    persistUsage(file) {
      usageStore = createGateStateStore({ file });
    },
    stats: () => ({
      upstreamRequests,
      pending,
      pausedForMs: Math.max(0, pauseEnd(current()) - now()),
      usedToday: usageStore.count(utcDay(now())),
      persistence: usageStore.status?.() || null,
    }),
  };
}

let sharedGate = createNominatimGate();

/** The process-wide gate: search and outlines share one budget and pacer. */
export function sharedNominatimGate() {
  return sharedGate;
}

/** Replace the process-wide gate (tests, embedders with their own transport). */
export function setSharedNominatimGate(gate) {
  sharedGate = gate || createNominatimGate();
  return sharedGate;
}

/** Codes that mean "not now" rather than "no such place". */
export function isNominatimBusy(error) {
  return [
    'NOMINATIM_QUEUE_FULL',
    'NOMINATIM_ABANDONED',
    'NOMINATIM_PAUSED',
    'NOMINATIM_REFUSED',
    'NOMINATIM_DAILY_CAP',
  ].includes(error?.code);
}
