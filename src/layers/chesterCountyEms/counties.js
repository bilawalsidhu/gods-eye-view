/** Supported public county sources. IDs remain stable as coverage grows. */
export const COUNTIES = Object.freeze([
  {
    id: 'chester-pa',
    name: 'Chester County, PA',
    source: 'Chester WebCAD',
    url: 'https://www.chesco.org/3963/WebCad-Active-Incidents',
  },
  {
    id: 'montgomery-pa',
    name: 'Montgomery County, PA',
    source: 'Montgomery WebCAD',
    url: 'https://www.montgomerycountypa.gov/departments/department-public-safety/webcad-active-incidents',
  },
  {
    id: 'lancaster-pa',
    name: 'Lancaster County, PA',
    source: 'Lancaster LCWC',
    url: 'https://www.lcwc911.us/live-incident-list',
  },
  {
    id: 'delaware-pa',
    name: 'Delaware County, PA',
    source: 'Delco Dispatch',
    url: 'https://delcodispat.ch/d/pa/delco',
    official: false,
    coverageKind: 'recent-dispatches',
  },
  {
    id: 'dauphin-pa',
    name: 'Dauphin County, PA',
    source: 'Dauphin WebCAD',
    url: 'https://dpswebcad.dauphincounty.gov/webcad/',
  },
  {
    id: 'pike-pa',
    name: 'Pike County, PA',
    source: 'Pike public press feed',
    url: 'https://webcad.pikepa.org/pages/public/FeedReader.asp',
    coverageKind: 'completed-reports',
    defaultEnabled: false,
  },
  {
    id: 'york-pa',
    name: 'York County, PA',
    source: 'York WebCAD',
    url: 'https://ycdes.org/webcad/default.aspx',
  },
  {
    id: 'adams-pa',
    name: 'Adams County, PA',
    source: 'Adams active incidents',
    url: 'https://incidents.adamscountypa.gov/',
  },
  {
    id: 'lebanon-pa',
    name: 'Lebanon County, PA',
    source: '717 Alerts / Lebanon DES pager',
    url: 'https://717alerts.com/county/lebanon',
    official: false,
    coverageKind: 'recent-dispatches',
  },
]);
/** Bounded, source-qualified identities admitted by local HTTP and AI tools. */
export const COUNTY_INCIDENT_ID_PATTERN =
  '^(?:(fire|ems|traffic):[FP][0-9]{8}|montgomery-pa:(fire|ems|traffic):[A-Z][0-9]{7,9}|(?:lancaster|dauphin|york|lebanon)-pa:(fire|ems|traffic):[a-f0-9]{24}|(?:pike|adams)-pa:(fire|ems|traffic):[0-9]{1,16}|delaware-pa:(fire|ems|traffic):[A-Za-z0-9-]{1,32})$';
/** Older Chester snapshots did not need an explicit county field. */
export const countyFor = (row) =>
  COUNTIES.find((county) => county.id === (row?.countyId || 'chester-pa')) ||
  COUNTIES[0];
/** Admit only the selected incident's public county page, never arbitrary URLs. */
export function incidentSource(row) {
  try {
    const url = new URL(row.detailUrl);
    if (url.username || url.password || url.hash) return null;
    if (
      [
        'lancaster-pa',
        'delaware-pa',
        'dauphin-pa',
        'pike-pa',
        'lebanon-pa',
      ].includes(row.countyId)
    ) {
      return url.href === countyFor(row).url ? url.href : null;
    }
    if (row.countyId === 'york-pa') {
      return url.origin === 'https://ycdes.org' &&
        url.pathname === '/webcad/Details.aspx' &&
        /^\?[A-Za-z0-9+/=%]{1,220}$/.test(url.search)
        ? url.href
        : null;
    }
    if (row.countyId === 'adams-pa') {
      return url.origin === 'https://incidents.adamscountypa.gov' &&
        url.pathname === '/unit_details' &&
        url.searchParams.get('call_number') === row.incidentNumber &&
        [...url.searchParams].length === 1
        ? url.href
        : null;
    }
    if (row.countyId === 'montgomery-pa') {
      return url.origin === 'https://webapp07.montcopa.org' &&
        url.pathname === '/eoc/cadinfo/livecad-incidents.asp' &&
        url.searchParams.get('incident') === row.incidentNumber &&
        [...url.searchParams].length === 1
        ? url.href
        : null;
    }
    return url.origin === 'https://webcad.chesco.org' &&
      url.pathname === '/WebCad/livecadcomments-' + row.category + '.asp' &&
      url.searchParams.get('incidentno') === row.incidentNumber
      ? url.href
      : null;
  } catch {
    return null;
  }
}
