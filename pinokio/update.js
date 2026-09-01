module.exports = {
  run: [
    {
      method: 'shell.run',
      params: {
        path: '..',
        // Update reuses the install doctor. The child re-reads raw app
        // ENVIRONMENT so blank fields override Pinokio-global values too.
        env: {
          GOOGLE_MAPS_API_KEY: '{{env.GOOGLE_MAPS_API_KEY || ""}}',
          CESIUM_ION_TOKEN: '{{env.CESIUM_ION_TOKEN || ""}}',
          OPENAI_API_KEY: '{{env.OPENAI_API_KEY || ""}}',
          AISSTREAM_API_KEY: '{{env.AISSTREAM_API_KEY || ""}}',
          FIRMS_MAP_KEY: '{{env.FIRMS_MAP_KEY || ""}}',
          TOMTOM_API_KEY: '{{env.TOMTOM_API_KEY || ""}}',
          OPENSKY_CLIENT_ID: '{{env.OPENSKY_CLIENT_ID || ""}}',
          OPENSKY_CLIENT_SECRET: '{{env.OPENSKY_CLIENT_SECRET || ""}}',
          LL2_API_TOKEN: '{{env.LL2_API_TOKEN || ""}}',
          GEV_RATELIMIT_OPENAI_PER_MIN: '{{env.GEV_RATELIMIT_OPENAI_PER_MIN || ""}}',
          GEV_RATELIMIT_GOOGLE_PER_MIN: '{{env.GEV_RATELIMIT_GOOGLE_PER_MIN || ""}}',
        },
        message: 'node scripts/pinokio-update.mjs',
      },
    },
  ],
};
