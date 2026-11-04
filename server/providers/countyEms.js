import {
  createDauphinCountyFeed,
  createPikeCountyFeed,
  createYorkCountyFeed,
  createYorkDetails,
} from './countyEms/listFeeds.js';
import {
  createAdamsCountyFeed,
  createAdamsDetails,
} from './countyEms/adams.js';
import { createLebanonCountyFeed } from './countyEms/lebanon.js';
import { COUNTY_INCIDENT_ID_PATTERN } from '../../src/layers/chesterCountyEms/counties.js';
import { createLancasterCountyFeed } from './countyEms/lancaster.js';
import { createDelawareCountyFeed } from './countyEms/delaware.js';
import { createAssignmentDetails } from './countyEms/publicFeed.js';
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
  const lancaster = createLancasterCountyFeed(options);
  const delaware = createDelawareCountyFeed(options);
  const dauphin = createDauphinCountyFeed(options);
  const pike = createPikeCountyFeed(options);
  const york = createYorkCountyFeed(options);
  const adams = createAdamsCountyFeed(options);
  const lebanon = createLebanonCountyFeed(options);
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
    {
      id: 'lancaster-pa',
      name: 'Lancaster County, PA',
      getSnapshot: lancaster,
      getDetails: createAssignmentDetails({ getSnapshot: lancaster }),
    },
    {
      id: 'delaware-pa',
      name: 'Delaware County, PA',
      official: false,
      coverageKind: 'recent-dispatches',
      limited: true,
      sourceLimit: 20,
      recentWindowMinutes: 120,
      getSnapshot: delaware,
      getDetails: createAssignmentDetails({ getSnapshot: delaware }),
    },
    {
      id: 'dauphin-pa',
      name: 'Dauphin County, PA',
      getSnapshot: dauphin,
      getDetails: createAssignmentDetails({ getSnapshot: dauphin }),
    },
    {
      id: 'pike-pa',
      name: 'Pike County, PA',
      coverageKind: 'completed-reports',
      limited: true,
      getSnapshot: pike,
      getDetails: createAssignmentDetails({ getSnapshot: pike }),
    },
    {
      id: 'york-pa',
      name: 'York County, PA',
      getSnapshot: york,
      getDetails: createYorkDetails({ ...options, getSnapshot: york }),
    },
    {
      id: 'adams-pa',
      name: 'Adams County, PA',
      getSnapshot: adams,
      getDetails: createAdamsDetails({ getSnapshot: adams }),
    },
    {
      id: 'lebanon-pa',
      name: 'Lebanon County, PA',
      official: false,
      coverageKind: 'recent-dispatches',
      limited: true,
      recentWindowMinutes: 120,
      getSnapshot: lebanon,
      getDetails: createAssignmentDetails({ getSnapshot: lebanon }),
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
        official: county.official !== false,
        coverageKind: county.coverageKind || 'active-incidents',
        limited: !!county.limited,
        sourceLimit: county.sourceLimit,
        recentWindowMinutes: county.recentWindowMinutes,
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
      timestampBasis: snapshot.timestampBasis || 'source',
      coverageKind: snapshot.coverageKind || 'active-incidents',
      official: snapshot.official !== false,
      limited: !!snapshot.limited,
      sourceLimit: snapshot.sourceLimit,
      recentWindowMinutes: snapshot.recentWindowMinutes,
      excludedCount: snapshot.excludedCount,
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
        ? !new RegExp(COUNTY_INCIDENT_ID_PATTERN).test(id) ||
          [...url.searchParams].length !== 1
        : Boolean(url.search)
    ) {
      res.statusCode = 400;
      return res.end('{}');
    }
    try {
      const county = feeds.find(
        (feed) =>
          feed.id ===
          (id.split(':').length === 3 ? id.split(':')[0] : 'chester-pa'),
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
