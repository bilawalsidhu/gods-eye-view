import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { airTemperatureProxy } from '../../server/providers/airTemperature.js';

export const START = Date.UTC(2026, 8, 15, 12);

export function snapshot(step = 6) {
  return {
    cycle: {
      date: '20260915',
      hour: 6,
      forecastHour: step,
      runIso: '2026-09-15T06:00:00.000Z',
      validIso: new Date(Date.UTC(2026, 8, 15, 6 + step)).toISOString(),
    },
    level: '2 m above ground',
    units: '°C',
    grid: {
      nx: 2,
      ny: 2,
      lo1: 0,
      la1: 90,
      dx: 180,
      dy: 180,
      scalar: Float32Array.of(-12.34, 0, step, 45.67),
    },
  };
}

export function install(options = {}) {
  const plugin = airTemperatureProxy({
    now: () => START,
    loadImpl: async () => snapshot(),
    ...options,
  });
  const routes = [];
  const server = {
    middlewares: { use: (path, handler) => routes.push({ path, handler }) },
  };
  plugin.configureServer(server);
  plugin.configurePreviewServer(server);
  assert.equal(routes[0].path, '/api/air-temperature');
  assert.equal(routes[1].path, routes[0].path);
  assert.equal(routes[1].handler, routes[0].handler);
  const handler = routes[0].handler;
  const request = async (url = '/', method = 'GET') => {
    const res = new EventEmitter();
    res.writeHead = (status, headers) => {
      res.status = status;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
    };
    await handler(
      { url: url.replace('/api/air-temperature', ''), method },
      res,
    );
    return res;
  };
  return { request, handler };
}
