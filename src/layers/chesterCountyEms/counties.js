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
]);
/** Older Chester snapshots did not need an explicit county field. */
export const countyFor = (row) =>
  COUNTIES.find((county) => county.id === (row?.countyId || 'chester-pa')) ||
  COUNTIES[0];
/** Admit only the selected incident's public county page, never arbitrary URLs. */
export function incidentSource(row) {
  try {
    const url = new URL(row.detailUrl);
    if (url.username || url.password || url.hash) return null;
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
