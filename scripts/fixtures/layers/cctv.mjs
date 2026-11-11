import sharp from 'sharp';

// Transport fixtures are parsed by the real CCTV catalog and media owners.
export const cameras = Array.from({ length: 25 }, (_, i) => ({
  id: `fixture-cctv-${String(i).padStart(3, '0')}`,
  name: i === 12 ? 'Cámara pública — Congress' : `Fixture camera ${i}`,
  cityId: 'austin',
  city: 'Austin',
  lat: 30.2672 + (Math.floor(i / 5) - 2) * 0.0018,
  lon: -97.7431 + ((i % 5) - 2) * 0.0018,
  headingDeg: (i * 37) % 360,
  fovDeg: i % 2 ? 44 : 56,
  rangeM: i % 2 ? 145 : 210,
  mountHeightM: i % 2 ? 8 : 10,
  pitchDeg: i % 2 ? -18 : -24,
  groundElevationM: 150,
  headingConfidence: i % 3 ? 'medium' : 'low',
  sourceKind: 'configured',
  feedType: 'image',
  provider: 'Deterministic fixture',
  url: 'https://cctv-fixture.invalid/frame.png',
}));

export async function cameraFrame() {
  const width = 320,
    height = 180;
  const pixels = Buffer.alloc(width * height * 3);
  const colors = [
    [240, 45, 70],
    [35, 220, 90],
    [40, 90, 235],
    [245, 210, 30],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color =
        colors[(x >= width / 2 ? 1 : 0) + (y >= height / 2 ? 2 : 0)];
      const grid = x % 40 < 2 || y % 30 < 2;
      const at = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) pixels[at + c] = grid ? 15 : color[c];
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

export async function installCctvFixture(page, { video } = {}) {
  const frame = await cameraFrame();
  const catalog = cameras.map((camera) => ({ ...camera }));
  if (video)
    catalog.push({
      ...cameras[0],
      id: 'fixture-cctv-video',
      name: 'Fixture moving video',
      lat: 30.2718,
      lon: -97.744,
      feedType: 'video',
      url: 'https://cctv-fixture.invalid/camera.mp4',
    });
  const ids = new Set(catalog.map((camera) => camera.id));
  // Global Puppeteer interception can stall Cesium's module workers in
  // Chromium 152. Intercept only fixture API routes on the page's CDP session.
  const session = await page.createCDPSession();
  let disposed = false;
  const routes = [
    '/api/cctv/*',
    '/api/flights*',
    '/api/military*',
    '/api/vessels*',
    '/api/google/nearby-places*',
  ];
  await session.send('Fetch.enable', {
    patterns: ['localhost', '127.0.0.1'].flatMap((host) =>
      routes.map((route) => ({ urlPattern: `http://${host}:*${route}` })),
    ),
  });
  const respond = (
    requestId,
    { status, contentType, headers = {}, body = '' },
  ) =>
    session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: Object.entries({
        ...(contentType ? { 'content-type': contentType } : {}),
        ...headers,
      }).map(([name, value]) => ({ name, value: String(value) })),
      body: Buffer.from(body).toString('base64'),
    });
  const handle = (request) => {
    const url = new URL(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      return request.continue();
    }
    const json = (body) =>
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    const auxiliary = {
      '/api/flights': { states: [] },
      '/api/military': { ac: [] },
      '/api/vessels': { connected: false, vessels: [] },
    };
    if (auxiliary[url.pathname]) {
      return json(auxiliary[url.pathname]);
    }
    if (url.pathname === '/api/cctv/sources') {
      return json({ sources: catalog });
    }
    if (url.pathname === '/api/cctv/health') {
      return json({
        cameras: catalog.map(({ id, feedType }) => ({
          id,
          status: 'online',
          sourceKind: feedType,
          label: 'Deterministic fixture',
          updatedAt: Date.now(),
        })),
      });
    }
    const media = url.pathname.match(/^\/api\/cctv\/(frame|media)\/([^/]+)$/);
    if (media) {
      const id = decodeURIComponent(media[2]);
      if (
        !ids.has(id) ||
        (media[1] === 'media' && (id !== 'fixture-cctv-video' || !video))
      ) {
        return request.respond({ status: 404, body: 'Unknown fixture camera' });
      }
      if (media[1] === 'frame') {
        return request.respond({
          status: 200,
          contentType: 'image/png',
          body: frame,
        });
      }
      const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end =
        range && range[2]
          ? Math.min(Number(range[2]), video.length - 1)
          : video.length - 1;
      if (start > end || start >= video.length) {
        return request.respond({
          status: 416,
          headers: { 'content-range': `bytes */${video.length}` },
        });
      }
      return request.respond({
        status: range ? 206 : 200,
        contentType: 'video/mp4',
        headers: {
          'accept-ranges': 'bytes',
          ...(range
            ? { 'content-range': `bytes ${start}-${end}/${video.length}` }
            : {}),
        },
        body: video.subarray(start, end + 1),
      });
    }
    if (url.pathname === '/api/google/nearby-places') {
      return json({ places: [] });
    }
    return request.continue();
  };
  session.on('Fetch.requestPaused', (event) => {
    const request = {
      url: () => event.request.url,
      headers: () =>
        Object.fromEntries(
          Object.entries(event.request.headers).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        ),
      respond: (response) => respond(event.requestId, response),
      continue: () =>
        session.send('Fetch.continueRequest', { requestId: event.requestId }),
    };
    Promise.resolve()
      .then(() => handle(request))
      .catch((error) => {
        if (!disposed && !page.isClosed()) page.emit('pageerror', error);
      });
  });
  return {
    cameras: catalog,
    frame,
    async dispose() {
      disposed = true;
      await session.detach();
    },
  };
}
