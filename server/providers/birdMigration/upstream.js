import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';

const TGFTP = 'https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar';
const IEM_LIST = 'https://mesonet.agron.iastate.edu/json/radar.py';
const DIRECTORIES = Object.freeze({ N0U: 'DS.p99v0', N0C: 'DS.161c0' });
const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';
const KIB = 1024;

/** Fixed hosts only; every request refuses redirects and caps its body. */
export function createRadarUpstream({ fetchImpl }) {
  async function get(url, signal) {
    const response = await fetchImpl(url, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream HTTP ${response.status}`);
    }
    return response;
  }

  return {
    /** IEM's five-minute USCOMP N0Q scans in [from, to], as ISO minutes. */
    async compositeScans(from, to, signal) {
      const query = new URLSearchParams({
        operation: 'list',
        radar: 'USCOMP',
        product: 'N0Q',
        start: new Date(from).toISOString().slice(0, 16) + 'Z',
        end: new Date(to).toISOString().slice(0, 16) + 'Z',
      });
      const body = await readResponseJsonCapped(
        await get(`${IEM_LIST}?${query}`, signal),
        64 * KIB,
        signal,
      );
      if (!Array.isArray(body?.scans)) throw new Error('invalid scan list');
      return body.scans
        .map(({ ts } = {}) =>
          typeof ts === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/.test(ts)
            ? `${ts.slice(0, 16)}:00.000Z`
            : null,
        )
        .filter(Boolean);
    },
    /** Lower-48 style `K***` site ids that publish velocity. */
    async sites(signal) {
      const html = await readResponseTextCapped(
        await get(`${TGFTP}/${DIRECTORIES.N0U}/`, signal),
        256 * KIB,
        signal,
      );
      return [...html.matchAll(/href="SI\.(k[a-z]{3})\/"/g)].map(([, site]) =>
        site.toUpperCase(),
      );
    },
    /** One site's rolling file ring with arrival times (UTC, minute precision). */
    async files(site, product, signal) {
      const html = await readResponseTextCapped(
        await get(
          `${TGFTP}/${DIRECTORIES[product]}/SI.${site.toLowerCase()}/`,
          signal,
        ),
        256 * KIB,
        signal,
      );
      const files = [];
      for (const [, file, day, month, year, hour, minute] of html.matchAll(
        /href="(sn\.\d{4})">[^<]*<\/a><\/td><td[^>]*>(\d\d)-([A-Z][a-z]{2})-(\d{4}) (\d\d):(\d\d)/g,
      )) {
        const monthIndex = MONTHS.indexOf(month) / 3;
        if (!Number.isInteger(monthIndex)) continue;
        files.push({
          file,
          arrivedAt: Date.UTC(+year, monthIndex, +day, +hour, +minute),
        });
      }
      return files;
    },
    async bytes(site, product, file, signal) {
      if (!/^sn\.(\d{4}|last)$/.test(file)) throw new Error('invalid file');
      return readResponseBytesCapped(
        await get(
          `${TGFTP}/${DIRECTORIES[product]}/SI.${site.toLowerCase()}/${file}`,
          signal,
        ),
        512 * KIB,
        signal,
      );
    },
  };
}
