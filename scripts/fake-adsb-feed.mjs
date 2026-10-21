#!/usr/bin/env node
/**
 * A fake local ADS-B decoder for trying Local ADS-B and Reception Horizon
 * without a radio. Serves a synthetic sky (`scripts/synthetic-adsb.mjs`) the
 * way dump1090-fa does: `/data/aircraft.json` and `/data/receiver.json`.
 *
 *   node scripts/fake-adsb-feed.mjs [--port 8090] [--lat 30.2672 --lon -97.7431] [--no-location] [--speed 1]
 *
 * Then start the app with the feed configured and turn on Local ADS-B and
 * Reception Horizon:
 *
 *   LOCAL_RECEIVER_FEEDS=1090=http://127.0.0.1:8090/data/aircraft.json npm run dev
 *
 * `--no-location` leaves `lat`/`lon` out of receiver.json, as a decoder
 * started without a location does, to try LOCATE and SET ANTENNA instead.
 * `--speed 20` plays the sky 20 times faster, so the horizon fills in
 * minutes rather than hours.
 */
import http from 'node:http';
import { createSyntheticSky } from './synthetic-adsb.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option('--port', 8090));
const antenna = {
  lat: Number(option('--lat', 30.2672)),
  lon: Number(option('--lon', -97.7431)),
};
const sky = createSyntheticSky({
  antenna,
  location: !args.includes('--no-location'),
  timeScale: Math.max(1, Number(option('--speed', 1)) || 1),
});

const server = http.createServer((req, res) => {
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  const body =
    path === '/data/aircraft.json'
      ? sky.aircraftJson(Date.now())
      : path === '/data/receiver.json'
        ? sky.receiverJson()
        : null;
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `[fake-adsb-feed] http://127.0.0.1:${port}/data/aircraft.json (antenna ${antenna.lat}, ${antenna.lon})`,
  );
  console.log(
    `[fake-adsb-feed] LOCAL_RECEIVER_FEEDS=1090=http://127.0.0.1:${port}/data/aircraft.json`,
  );
});
