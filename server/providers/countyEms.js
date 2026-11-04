import {
  chesterCountyEmsProxy,
  createChesterCountyFeed,
  createChesterCountyDetails,
} from './chesterCountyEms.js';
import {
  createMontgomeryCountyFeed,
  createMontgomeryCountyDetails,
} from './countyEms/montgomery.js';

/** Add a county by supplying its bounded snapshot/detail adapters here. */
export function createCountyFeeds(options = {}) {
  const chester = createChesterCountyFeed(options);
  const montgomery = createMontgomeryCountyFeed(options);
  return [
    {
      id: 'chester-pa',
      name: 'Chester County, PA',
      getSnapshot: chester,
      getDetails: createChesterCountyDetails({
        ...options,
        getSnapshot: chester,
      }),
    },
    {
      id: 'montgomery-pa',
      name: 'Montgomery County, PA',
      getSnapshot: montgomery,
      getDetails: createMontgomeryCountyDetails({
        ...options,
        getSnapshot: montgomery,
      }),
    },
  ];
}
/** A source failure never removes another county's available reports. */
export async function countySnapshot(feeds, now = Date.now) {
  const results = await Promise.allSettled(
    feeds.map((feed) => feed.getSnapshot()),
  );
  if (results.every((result) => result.status === 'rejected'))
    throw new Error('County incidents unavailable');
  const rows = [],
    countyFeeds = [];
  results.forEach((result, index) => {
    const county = feeds[index];
    if (result.status === 'rejected') {
      countyFeeds.push({
        id: county.id,
        county: county.name,
        unavailable: true,
        stale: true,
        count: 0,
        observedAt: null,
        fetchedAt: null,
      });
      return;
    }
    const snapshot = result.value;
    rows.push(
      ...snapshot.rows.map((row) => ({
        ...row,
        countyId: county.id,
        county: county.name,
      })),
    );
    countyFeeds.push({
      id: county.id,
      county: county.name,
      unavailable: false,
      stale: snapshot.stale,
      count: snapshot.rows.length,
      observedAt: snapshot.observedAt,
      fetchedAt: snapshot.fetchedAt,
    });
  });
  return {
    rows,
    countyFeeds,
    observedAt: Math.min(
      ...countyFeeds
        .filter((feed) => feed.observedAt !== null)
        .map((feed) => feed.observedAt),
    ),
    fetchedAt: now(),
    stale: countyFeeds.some((feed) => feed.stale),
    locationCoverage: {
      matched: rows.filter((row) => row.mapPosition).length,
      unmatched: rows.filter((row) => row.locationStatus === 'unmatched')
        .length,
      unavailable: rows.filter((row) => row.locationStatus === 'unavailable')
        .length,
    },
  };
}
/** Fixed local API for combined coverage; the old Chester endpoint stays scoped. */
export function countyEmsProxy(options = {}) {
  const feeds = options.feeds || createCountyFeeds(options);
  const now = options.now || Date.now;
  async function handler(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    if (!['/', '/details'].includes(url.pathname)) return next();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      return res.end('{}');
    }
    const id = url.searchParams.get('incident') || '';
    if (
      url.pathname === '/details'
        ? !/^(?:(?:fire|ems|traffic):[FP]\d{8}|montgomery-pa:(?:fire|ems|traffic):[A-Z]\d{7,9})$/.test(
            id,
          ) || [...url.searchParams].length !== 1
        : Boolean(url.search)
    ) {
      res.statusCode = 400;
      return res.end('{}');
    }
    try {
      const county = feeds.find(
        (feed) =>
          feed.id ===
          (id.startsWith('montgomery-pa:') ? 'montgomery-pa' : 'chester-pa'),
      );
      res.end(
        JSON.stringify(
          await (url.pathname === '/details'
            ? county.getDetails(id)
            : countySnapshot(feeds, now)),
        ),
      );
    } catch (error) {
      res.statusCode = error.statusCode === 404 ? 404 : 502;
      res.end(JSON.stringify({ error: 'County incidents unavailable' }));
    }
  }
  const legacy = chesterCountyEmsProxy({
    ...options,
    getSnapshot: feeds[0].getSnapshot,
    getDetails: feeds[0].getDetails,
  });
  const install = ({ middlewares }) => {
    legacy.configureServer({ middlewares });
    middlewares.use('/api/county-ems', handler);
  };
  return {
    name: 'county-ems',
    configureServer: install,
    configurePreviewServer: install,
  };
}
