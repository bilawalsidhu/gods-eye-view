/**
 * @file Airline catalog validation and coverage.
 *
 * {@link validateAirlineCatalog} is the gate the tests and the builder run over
 * the catalog: designators are well formed and unique, and the country joins a
 * code the country library knows. {@link airlineCoverage} reports how many
 * entries carry a country, an IATA code and a tail colour. Pure: the caller
 * injects the known country codes.
 */

/**
 * Report every entry that fails the shape policy.
 * @param {object[]} catalog
 * @param {object} opts
 * @param {Iterable<string>} opts.knownIso2 Country codes an entry's `country` may name.
 * @returns {{key: string, problems: string[]}[]} empty when the catalog is clean.
 */
export function validateAirlineCatalog(catalog, { knownIso2 }) {
  const known = new Set(knownIso2);
  const seen = new Set();
  const failures = [];
  for (const entry of catalog) {
    const problems = [];
    if (!/^[A-Z]{3}$/.test(entry.icao ?? '')) problems.push('bad icao');
    if (seen.has(entry.icao)) problems.push('duplicate icao');
    seen.add(entry.icao);
    if (entry.iata !== null && !/^[A-Z0-9]{2}$/.test(entry.iata ?? ''))
      problems.push(`bad iata: ${entry.iata}`);
    if (!String(entry.name ?? '').trim()) problems.push('missing name');
    if (entry.callsign !== null && !String(entry.callsign ?? '').trim())
      problems.push('bad callsign');
    if (entry.country !== null && !known.has(entry.country))
      problems.push(`unknown country: ${entry.country}`);
    if (typeof entry.active !== 'boolean') problems.push('active');
    if (
      entry.tailColor !== null &&
      !/^#[0-9A-Fa-f]{6}$/.test(entry.tailColor ?? '')
    )
      problems.push(`bad tailColor: ${entry.tailColor}`);
    if (problems.length) failures.push({ key: entry.icao, problems });
  }
  return failures;
}

/**
 * How many entries carry each optional field.
 * @param {{country: string|null, iata: string|null, tailColor: string|null}[]} catalog
 * @returns {{total: number, withCountry: number, withIata: number, withTailColor: number}}
 */
export function airlineCoverage(catalog) {
  const count = (field) => catalog.filter((e) => e[field] !== null).length;
  return {
    total: catalog.length,
    withCountry: count('country'),
    withIata: count('iata'),
    withTailColor: count('tailColor'),
  };
}
