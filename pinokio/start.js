module.exports = {
  daemon: true,
  run: [
    {
      method: 'shell.run',
      params: {
        path: '..',
        env: {
          HOST: '127.0.0.1',
          PORT: '{{port}}',
          GOOGLE_MAPS_API_KEY: '{{env.GOOGLE_MAPS_API_KEY || ""}}',
          CESIUM_ION_TOKEN: '{{env.CESIUM_ION_TOKEN || ""}}',
          OPENAI_API_KEY: '{{env.OPENAI_API_KEY || ""}}',
          AISSTREAM_API_KEY: '{{env.AISSTREAM_API_KEY || ""}}',
          FIRMS_MAP_KEY: '{{env.FIRMS_MAP_KEY || ""}}',
          TOMTOM_API_KEY: '{{env.TOMTOM_API_KEY || ""}}',
          OPENSKY_CLIENT_ID: '{{env.OPENSKY_CLIENT_ID || ""}}',
          OPENSKY_CLIENT_SECRET: '{{env.OPENSKY_CLIENT_SECRET || ""}}',
          LL2_API_TOKEN: '{{env.LL2_API_TOKEN || ""}}',
          PINOKIO_SHARE_CLOUDFLARE: '{{env.PINOKIO_SHARE_CLOUDFLARE || "false"}}',
          PINOKIO_SHARE_LOCAL: '{{env.PINOKIO_SHARE_LOCAL || "false"}}',
          PINOKIO_SHARE_VAR: '{{env.PINOKIO_SHARE_VAR || "__gev_sharing_disabled__"}}',
          GEV_RATELIMIT_OPENAI_PER_MIN: '{{env.GEV_RATELIMIT_OPENAI_PER_MIN || ""}}',
          GEV_RATELIMIT_GOOGLE_PER_MIN: '{{env.GEV_RATELIMIT_GOOGLE_PER_MIN || ""}}',
        },
        message: 'node scripts/pinokio-start.mjs',
        on: [{
          event: '/\\[Pinokio\\] Ready at (http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/)/',
          done: true,
        }],
      },
    },
    {
      // Pinokio requires local.url for ready/Open state. PINOKIO_SHARE_VAR is
      // pinned to a different sentinel so local.set cannot trigger sharing.
      method: 'local.set',
      params: {
        url: '{{input.event[1]}}',
      },
    },
  ],
};
