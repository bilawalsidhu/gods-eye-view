
// shortcuts for easier to read formulas
const {PI, sin, cos, tan, asin, atan2: atan, acos, sqrt, abs, round, floor} = Math;
const rad = PI / 180;

// date/time constants and conversions

const dayMs = 1000 * 60 * 60 * 24;
const J1970 = 2440588;
const J2000 = 2451545;
const earthRadius = 6378.14; // equatorial radius in km, for the Moon's topocentric parallax

function fromJulian(j) {
    return new Date((j + 0.5 - J1970) * dayMs);
}
function toDays(date) {
    return date.valueOf() / dayMs - 0.5 + J1970 - J2000;
}

// ΔT = TT − UT in seconds (Espenak & Meeus polynomial fits, good ~1900–2150). The Meeus position
// series are defined in Terrestrial Time, but SunCalc's input Dates are UT — so the position math
// runs on days-since-J2000 shifted by deltaT, while sidereal time stays on UT. ~69 s today;
// negligible for the Sun (<0.001°), real for the Moon. d only needs ~month accuracy here (ΔT
// changes <1 s/yr), so the decimal year is derived arithmetically from d rather than from the Date.
function deltaT(d) {
    const y = 2000 + d / 365.2425;
    let t;
    if (y < 1920) { t = y - 1900; return -2.79 + t * (1.494119 + t * (-0.0598939 + t * (0.0061966 - t * 0.000197))); }
    if (y < 1941) { t = y - 1920; return 21.20 + t * (0.84493 + t * (-0.076100 + t * 0.0020936)); }
    if (y < 1961) { t = y - 1950; return 29.07 + t * (0.407 + t * (-1 / 233 + t / 2547)); }
    if (y < 1986) { t = y - 1975; return 45.45 + t * (1.067 + t * (-1 / 260 - t / 718)); }
    if (y < 2005) { t = y - 2000; return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 + t * (0.000651814 + t * 0.00002373599)))); }
    if (y < 2050) { t = y - 2000; return 62.92 + t * (0.32217 + t * 0.005589); }
    t = (y - 1820) / 100; return -20 + 32 * t * t - 0.5628 * (2150 - y);
}
function toDaysTT(d) {
    return d + deltaT(d) / 86400;
}

// general calculations for position

// north-based clockwise azimuth in degrees (0 = N, 90 = E, 180 = S, 270 = W)
function azimuth(H, phi, dec) {
    return (atan(sin(H), cos(H) * sin(phi) - tan(dec) * cos(phi)) / rad + 540) % 360;
}
function altitude(H, phi, dec) {
    return asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
}

// Greenwich mean sidereal time, formula 12.4 of Meeus (linear term; sub-arcsec T^2/T^3 dropped)
function siderealTime(d, lw) {
    return rad * (280.46061837 + 360.98564736629 * d) - lw;
}

function astroRefraction(h) {
    if (h < 0) h = 0; // formula valid for positive altitudes only

    // Meeus 16.4: 1.02 / tan(h + 10.26 / (h + 5.10)), h in degrees, arcmin result — folded into rad
    return 0.0002967 / tan(h + 0.00312536 / (h + 0.08901179));
}

// general sun calculations

// Sun's apparent equatorial coordinates, Meeus ch. 25. d = days since J2000 (TT); t = Julian centuries.
function sunCoords(d) {
    const t = d / 36525;
    const L0 = rad * (280.46646 + t * (36000.76983 + t * 0.0003032)); // 25.2 geometric mean longitude
    const M = rad * (357.52911 + t * (35999.05029 - t * 0.0001537)); // 25.3 mean anomaly
    const sinM = sin(M);
    const cosM = cos(M);
    const C = rad * ((1.914602 - t * (0.004817 + t * 0.000014)) * sinM + // equation of center
        (0.019993 - 0.000101 * t) * 2 * sinM * cosM + 0.000289 * sinM * (3 - 4 * sinM * sinM));
    const Om = rad * (125.04 - 1934.136 * t); // longitude of the ascending node
    const L = L0 + C - rad * (0.00569 + 0.00478 * sin(Om)); // apparent longitude (nutation + aberration)
    // 22.2 mean obliquity + 25.8 correction for apparent position
    const e = rad * (23.439291 - t * (0.0130042 + t * (0.00000016 - t * 0.000000504))) + rad * 0.00256 * cos(Om);

    return {
        ra: atan(cos(e) * sin(L), cos(L)), // 25.6
        dec: asin(sin(e) * sin(L)),        // 25.7
        lon: L
    };
}

// calculates sun position for a given date and latitude/longitude
export function getPosition(date, lat, lng) {
    const lw = rad * -lng;
    const phi = rad * lat;
    const d = toDays(date);

    const c = sunCoords(toDaysTT(d)); // position series run on Terrestrial Time
    const H = siderealTime(d, lw) - c.ra; // sidereal time stays on UT
    const h = altitude(H, phi, c.dec);

    return {
        azimuth: azimuth(H, phi, c.dec),
        // apparent (refraction-corrected) altitude in degrees
        altitude: (h + astroRefraction(h)) / rad
    };
}

// sun times configuration (angle, morning name, evening name)
export const times = [
    [-0.833, 'sunrise', 'sunset'],
    [-0.3, 'sunriseEnd', 'sunsetStart'],
    [-6, 'dawn', 'dusk'],
    [-12, 'nauticalDawn', 'nauticalDusk'],
    [-18, 'nightEnd', 'night'],
    [6, 'goldenHourEnd', 'goldenHour']
];

// adds a custom time to the times config
export function addTime(angle, riseName, setName) {
    times.push([angle, riseName, setName]);
}

// calculations for sun times — Meeus ch.15 (rising, transit, setting), solving the Sun's
// local hour angle directly off the same apparent coordinates (sunCoords) and sidereal time
// used by getPosition. Day offsets d are in UT days since J2000; the position series run on TT.

const J0 = 0.0009;

function observerAngle(height) {
    return -2.076 * sqrt(height) / 60;
}

// wrap an angle to (-PI, PI]
function wrapPi(a) {
    return a - 2 * PI * round(a / (2 * PI));
}

// refines a transit time so the Sun's local hour angle is zero (Meeus 15.2; dH/dd ~= 2*PI/day,
// the sidereal excess and the Sun's own motion cancelling to one solar day).
function solarTransit(dt, lw) {
    for (let i = 0; i < 3; i++) {
        const H = wrapPi(siderealTime(dt, lw) - sunCoords(toDaysTT(dt)).ra);
        dt -= H / (2 * PI);
    }
    return dt;
}

// time the Sun reaches altitude h0 on the given side of transit (sign -1 = rise, +1 = set);
// starts from the hour angle at transit and converges with Meeus' altitude correction (15.2).
function getSetJ(h0, dt, sign, lw, phi, decT) {
    const cosH0 = (sin(h0) - sin(phi) * sin(decT)) / (cos(phi) * cos(decT));
    if (cosH0 < -1 || cosH0 > 1) return NaN; // sun stays above / below this altitude all day

    let d = dt + sign * acos(cosH0) / (2 * PI);
    for (let i = 0; i < 2; i++) {
        const c = sunCoords(toDaysTT(d));
        const H = wrapPi(siderealTime(d, lw) - c.ra);
        const h = altitude(H, phi, c.dec);
        const sinH = cos(phi) * cos(c.dec) * sin(H);
        if (abs(sinH) < 1e-6) break; // grazing the horizon — correction is ill-conditioned
        d += (h - h0) / (2 * PI * sinH);
    }
    return d;
}

// start of the civil day containing date in a zone utcOffset minutes ahead of UTC, as a ms timestamp
function civilMidnight(date, utcOffset) {
    const offMs = utcOffset * 60000;
    return floor((date.valueOf() + offMs) / dayMs) * dayMs - offMs;
}

// solar transit (days since J2000) anchoring the day shared by getTimes and getMoonTimes: the one
// nearest the instant (the solar day containing it), or nearest civil noon when an offset is given
function solarDayTransit(date, lw, utcOffset) {
    const anchor = utcOffset === undefined ? date.valueOf() : civilMidnight(date, utcOffset) + dayMs / 2;
    const lon = J0 + lw / (2 * PI);
    return solarTransit(round(toDays(anchor) - lon) + lon, lw);
}

// calculates sun times for a given date, latitude/longitude, and, optionally, the observer height
// (in meters) relative to the horizon and the UTC offset (in minutes) of the observer's time zone

export function getTimes(date, lat, lng, height = 0, utcOffset) {

    const lw = rad * -lng;
    const phi = rad * lat;
    const dh = observerAngle(height);
    const dt = solarDayTransit(date, lw, utcOffset);
    const dec = sunCoords(toDaysTT(dt)).dec; // declination at transit, shared by every rise/set solve

    const result = {
        solarNoon: fromJulian(dt + J2000),
        nadir: fromJulian(dt + J2000 - 0.5)
    };

    for (const [angle, riseName, setName] of times) {
        const h0 = (angle + dh) * rad;
        const jrise = getSetJ(h0, dt, -1, lw, phi, dec);
        const jset = getSetJ(h0, dt, 1, lw, phi, dec);

        // a NaN means the Sun never reaches this altitude on this day — report null, not Invalid Date
        result[riseName] = Number.isNaN(jrise) ? null : fromJulian(jrise + J2000);
        result[setName] = Number.isNaN(jset) ? null : fromJulian(jset + J2000);
    }

    // polar day/night: when the Sun never crosses the standard rise/set altitude, flag which side it
    // stays on by comparing its altitude at solar noon (its daily maximum) against that threshold.
    if (result.sunrise === null) {
        const noonAlt = altitude(0, phi, dec);
        const riseSetAlt = (times[0][0] + dh) * rad;
        result.alwaysUp = noonAlt > riseSetAlt;
        result.alwaysDown = noonAlt <= riseSetAlt;
    }

    return result;
}

// moon calculations, based on Meeus ch. 47 (truncated ELP-2000/82 series)

// Nutation in longitude (Δψ) and true obliquity of the ecliptic, both in degrees,
// from the abridged series of Meeus ch. 22 (sub-arcsecond, ample for our needs).
function nutationObliquity(t) {
    const om = rad * (125.04452 - 1934.136261 * t); // longitude of the Moon's ascending node
    const ls = rad * (280.4665 + 36000.7698 * t);   // mean longitude of the Sun
    const lm = rad * (218.3165 + 481267.8813 * t);  // mean longitude of the Moon
    const dpsi = (-17.20 * sin(om) - 1.32 * sin(2 * ls) - 0.23 * sin(2 * lm) + 0.21 * sin(2 * om)) / 3600;
    const deps = (9.20 * cos(om) + 0.57 * cos(2 * ls) + 0.10 * cos(2 * lm) - 0.09 * cos(2 * om)) / 3600;
    const eps0 = 23.439291 - t * (0.0130042 + t * (0.00000016 - t * 0.000000504)); // 22.2 mean obliquity
    return {dpsi, eps: rad * (eps0 + deps)};
}

// Meeus table 47.A — periodic terms for the Moon's longitude (Σl, ×1e-6 deg) and
// distance (Σr, ×1e-3 km). Flat rows of 6: D, M, M', F, Σl, Σr.
const moonLon = new Int32Array([
    0, 0, 1, 0, 6288774, -20905355,
    2, 0, -1, 0, 1274027, -3699111,
    2, 0, 0, 0, 658314, -2955968,
    0, 0, 2, 0, 213618, -569925,
    0, 1, 0, 0, -185116, 48888,
    0, 0, 0, 2, -114332, -3149,
    2, 0, -2, 0, 58793, 246158,
    2, -1, -1, 0, 57066, -152138,
    2, 0, 1, 0, 53322, -170733,
    2, -1, 0, 0, 45758, -204586,
    0, 1, -1, 0, -40923, -129620,
    1, 0, 0, 0, -34720, 108743,
    0, 1, 1, 0, -30383, 104755,
    2, 0, 0, -2, 15327, 10321,
    0, 0, 1, 2, -12528, 0,
    0, 0, 1, -2, 10980, 79661,
    4, 0, -1, 0, 10675, -34782,
    0, 0, 3, 0, 10034, -23210,
    4, 0, -2, 0, 8548, -21636,
    2, 1, -1, 0, -7888, 24208,
    2, 1, 0, 0, -6766, 30824,
    1, 0, -1, 0, -5163, -8379,
    1, 1, 0, 0, 4987, -16675,
    2, -1, 1, 0, 4036, -12831,
    2, 0, 2, 0, 3994, -10445,
    4, 0, 0, 0, 3861, -11650,
    2, 0, -3, 0, 3665, 14403,
    0, 1, -2, 0, -2689, -7003,
    2, 0, -1, 2, -2602, 0,
    2, -1, -2, 0, 2390, 10056,
    1, 0, 1, 0, -2348, 6322,
    2, -2, 0, 0, 2236, -9884,
    0, 1, 2, 0, -2120, 5751,
    0, 2, 0, 0, -2069, 0,
    2, -2, -1, 0, 2048, -4950,
    2, 0, 1, -2, -1773, 4130,
    2, 0, 0, 2, -1595, 0,
    4, -1, -1, 0, 1215, -3958,
    0, 0, 2, 2, -1110, 0,
    3, 0, -1, 0, -892, 3258,
    2, 1, 1, 0, -810, 2616,
    4, -1, -2, 0, 759, -1897,
    0, 2, -1, 0, -713, -2117,
    2, 2, -1, 0, -700, 2354,
    2, 1, -2, 0, 691, 0,
    2, -1, 0, -2, 596, 0,
    4, 0, 1, 0, 549, -1423,
    0, 0, 4, 0, 537, -1117,
    4, -1, 0, 0, 520, -1571,
    1, 0, -2, 0, -487, -1739,
    2, 1, 0, -2, -399, 0,
    0, 0, 2, -2, -381, -4421,
    1, 1, 1, 0, 351, 0,
    3, 0, -2, 0, -340, 0,
    4, 0, -3, 0, 330, 0,
    2, -1, 2, 0, 327, 0,
    0, 2, 1, 0, -323, 1165,
    1, 1, -1, 0, 299, 0,
    2, 0, 3, 0, 294, 0,
    2, 0, -1, -2, 0, 8752
]);

// Meeus table 47.B — periodic terms for the Moon's latitude (Σb, ×1e-6 deg).
// Flat rows of 5: D, M, M', F, Σb.
const moonLat = new Int32Array([
    0, 0, 0, 1, 5128122,
    0, 0, 1, 1, 280602,
    0, 0, 1, -1, 277693,
    2, 0, 0, -1, 173237,
    2, 0, -1, 1, 55413,
    2, 0, -1, -1, 46271,
    2, 0, 0, 1, 32573,
    0, 0, 2, 1, 17198,
    2, 0, 1, -1, 9266,
    0, 0, 2, -1, 8822,
    2, -1, 0, -1, 8216,
    2, 0, -2, -1, 4324,
    2, 0, 1, 1, 4200,
    2, 1, 0, -1, -3359,
    2, -1, -1, 1, 2463,
    2, -1, 0, 1, 2211,
    2, -1, -1, -1, 2065,
    0, 1, -1, -1, -1870,
    4, 0, -1, -1, 1828,
    0, 1, 0, 1, -1794,
    0, 0, 0, 3, -1749,
    0, 1, -1, 1, -1565,
    1, 0, 0, 1, -1491,
    0, 1, 1, 1, -1475,
    0, 1, 1, -1, -1410,
    0, 1, 0, -1, -1344,
    1, 0, 0, -1, -1335,
    0, 0, 3, 1, 1107,
    4, 0, 0, -1, 1021,
    4, 0, -1, 1, 833,
    0, 0, 1, -3, 777,
    4, 0, -2, 1, 671,
    2, 0, 0, -3, 607,
    2, 0, 2, -1, 596,
    2, -1, 1, -1, 491,
    2, 0, -2, 1, -451,
    0, 0, 3, -1, 439,
    2, 0, 2, 1, 422,
    2, 0, -3, -1, 421,
    2, 1, -1, 1, -366,
    2, 1, 0, 1, -351,
    4, 0, 0, 1, 331,
    2, -1, 1, 1, 315,
    2, -2, 0, -1, 302,
    0, 0, 1, 3, -283,
    2, 1, 1, -1, -229,
    1, 1, 0, -1, 223,
    1, 1, 0, 1, 223,
    0, 1, -2, -1, -220,
    2, 1, -1, -1, -220,
    1, 0, 1, 1, -185,
    2, -1, -2, -1, 181,
    0, 1, 2, 1, -177,
    4, 0, -2, -1, 176,
    4, -1, -1, -1, 166,
    1, 0, 1, -1, -164,
    4, 0, 1, -1, 132,
    1, 0, -1, -1, -119,
    4, -1, 0, -1, 115,
    2, -2, 0, 1, 107
]);

// geocentric apparent equatorial coordinates of the Moon, Meeus ch. 47. d = days since J2000 (TT).
function moonCoords(d) {
    const t = d / 36525;

    // fundamental arguments (degrees), 47.1–47.6
    const Lp = 218.3164477 + t * (481267.88123421 + t * (-0.0015786 + t * (1 / 538841 - t / 65194000)));
    const D = 297.8501921 + t * (445267.1114034 + t * (-0.0018819 + t * (1 / 545868 - t / 113065000)));
    const M = 357.5291092 + t * (35999.0502909 + t * (-0.0001536 + t / 24490000));
    const Mp = 134.9633964 + t * (477198.8675055 + t * (0.0087414 + t * (1 / 69699 - t / 14712000)));
    const F = 93.2720950 + t * (483202.0175233 + t * (-0.0036539 + t * (-1 / 3526000 + t / 863310000)));
    const A1 = 119.75 + 131.849 * t;
    const A2 = 53.09 + 479264.290 * t;
    const A3 = 313.45 + 481266.484 * t;
    const E = 1 - t * (0.002516 + t * 0.0000074); // eccentricity factor for solar-anomaly terms

    const Dr = rad * D, Mr = rad * M, Mpr = rad * Mp, Fr = rad * F;
    let sl = 0, sr = 0, sb = 0;
    for (let i = 0; i < moonLon.length; i += 6) {
        const m = moonLon[i + 1];
        const arg = moonLon[i] * Dr + m * Mr + moonLon[i + 2] * Mpr + moonLon[i + 3] * Fr;
        const f = m === 1 || m === -1 ? E : m === 2 || m === -2 ? E * E : 1;
        sl += moonLon[i + 4] * f * sin(arg);
        sr += moonLon[i + 5] * f * cos(arg);
    }
    for (let i = 0; i < moonLat.length; i += 5) {
        const m = moonLat[i + 1];
        const arg = moonLat[i] * Dr + m * Mr + moonLat[i + 2] * Mpr + moonLat[i + 3] * Fr;
        const f = m === 1 || m === -1 ? E : m === 2 || m === -2 ? E * E : 1;
        sb += moonLat[i + 4] * f * sin(arg);
    }

    // additive terms (Venus, Jupiter and flattening of the Earth), 47 p.342
    const A1r = rad * A1, Lpr = rad * Lp;
    sl += 3958 * sin(A1r) + 1962 * sin(Lpr - Fr) + 318 * sin(rad * A2);
    sb += -2235 * sin(Lpr) + 382 * sin(rad * A3) + 175 * sin(A1r - Fr) + 175 * sin(A1r + Fr) +
        127 * sin(Lpr - Mpr) - 115 * sin(Lpr + Mpr);

    const {dpsi, eps} = nutationObliquity(t);
    const l = rad * (Lp + sl / 1e6 + dpsi); // apparent ecliptic longitude
    const b = rad * (sb / 1e6);             // ecliptic latitude

    return {
        ra: atan(sin(l) * cos(eps) - tan(b) * sin(eps), cos(l)),  // 13.3
        dec: asin(sin(b) * cos(eps) + cos(b) * sin(eps) * sin(l)), // 13.4
        dist: 385000.56 + sr / 1000, // distance to the Moon in km
        lon: l
    };
}

export function getMoonPosition(date, lat, lng) {
    const lw = rad * -lng;
    const phi = rad * lat;
    const d = toDays(date);
    const c = moonCoords(toDaysTT(d));    // position series run on Terrestrial Time
    const H = siderealTime(d, lw) - c.ra; // sidereal time stays on UT

    // geocentric parallax (Meeus ch.40) lowers the moon along its vertical circle, leaving
    // azimuth unchanged; sin(parallax) = (Earth radius / distance) * cos(geocentric altitude).
    const hGeo = altitude(H, phi, c.dec);
    const h = hGeo - asin(earthRadius / c.dist * cos(hGeo));

    // parallactic angle, Meeus 14.1
    const pa = atan(sin(H), tan(phi) * cos(c.dec) - sin(c.dec) * cos(H));

    return {
        azimuth: azimuth(H, phi, c.dec),
        // apparent (refraction-corrected) altitude in degrees
        altitude: (h + astroRefraction(h)) / rad,
        distance: c.dist,
        parallacticAngle: pa / rad
    };
}

// moon illumination parameters, Meeus ch. 48 (and idlastro's mphase.pro)
export function getMoonIllumination(date = new Date()) {
    const d = toDaysTT(toDays(date));
    const s = sunCoords(d);
    const m = moonCoords(d);
    const sdist = 149598000; // distance from Earth to Sun in km
    const phi = acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra));
    const inc = atan(sdist * sin(phi), m.dist - sdist * cos(phi));
    const angle = atan(cos(s.dec) * sin(s.ra - m.ra), sin(s.dec) * cos(m.dec) -
        cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra));

    // elongation in ecliptic longitude, which defines the named phases (Meeus ch. 49, USNO); the RA
    // difference behind `angle` crosses 0/180° hours off conjunction/opposition near the nodes
    const phase = (((m.lon - s.lon) / (2 * PI)) % 1 + 1) % 1;
    const waxing = phase < 0.5;

    return {
        // illuminated fraction, 0 (new) → 1 (full); reaches the exact extrema only at perfect
        // syzygy (eclipses), so a "full" moon typically peaks a hair under 1 — this is correct
        fraction: (1 + cos(inc)) / 2,
        // phase, 0 → 1: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter (waxing for phase < 0.5)
        phase,
        // position angle of the bright limb, degrees (v2: all angles emitted in degrees) — subtract
        // getMoonPosition().parallacticAngle, also degrees, to get the zenith-relative tilt
        angle: angle / rad,
        waxing // true while the Moon is waxing (new → full), false while waning (full → new)
    };
}

function hoursLater(date, h) {
    return new Date(date.valueOf() + h * dayMs / 24);
}

// height of the moon's upper limb above the rise/set horizon (deg): topocentric centre altitude plus
// the moon's semidiameter (0.2725 * equatorial horizontal parallax, so it tracks distance: ~0.25° at
// apogee, ~0.28° at perigee) plus the residual horizon refraction our model under-bends (~0.09°,
// tuned vs USNO). Crossing zero == upper-limb rise/set, the USNO convention.
function moonHeight(date, lat, lng) {
    const p = getMoonPosition(date, lat, lng);
    return p.altitude + 0.2725 * asin(earthRadius / p.distance) / rad + 0.09;
}

// polish a crossing time (ms): the quadratic sampler's parabola root sits up to ~0.2° off the true
// altitude curve, so Newton-refine against the real moonHeight. Two central-difference steps drop the
// mean error from ~0.65 to ~0.28 min; more don't help (near grazing dh/dt is small either way).
function refineMoonCross(tMs, lat, lng) {
    for (let i = 0; i < 2; i++) {
        const h = moonHeight(new Date(tMs), lat, lng);
        const dh = (moonHeight(new Date(tMs + 30000), lat, lng) - moonHeight(new Date(tMs - 30000), lat, lng)) / 60000;
        tMs -= h / dh; // dh is degrees per ms, so h/dh is ms
    }
    return tMs;
}

// the moon's local hour angle (radians, unwrapped) at a ms timestamp
function moonHourAngle(t, lw) {
    const d = toDays(t);
    return siderealTime(d, lw) - moonCoords(toDaysTT(d)).ra;
}

// time (ms) in [t0, t0 + 1 day) when the moon's hour angle reaches H0 (0 = upper transit, PI = lower),
// or undefined when the window misses it, about once a month since the lunar day lasts ~24.8 hours
function moonTransit(t0, lw, H0) {
    const rate = 2 * PI * 0.96614 / dayMs; // mean hour angle rate (347.8° per day) in radians per ms
    const a = H0 - moonHourAngle(t0, lw);
    let t = t0 + (a - 2 * PI * floor(a / (2 * PI))) / rate; // first crossing after t0 at the mean rate
    for (let i = 0; i < 2; i++) t -= wrapPi(moonHourAngle(t, lw) - H0) / rate;
    return t < t0 + dayMs ? t : undefined;
}

export function getMoonTimes(date, lat, lng, utcOffset) {
    // scan the same day getTimes resolves: the 24 hours from the solar nadir, or from civil midnight
    // when the observer's UTC offset is given
    const t = utcOffset === undefined ?
        fromJulian(solarDayTransit(date, rad * -lng) + J2000 - 0.5) :
        new Date(civilMidnight(date, utcOffset));

    let h0 = moonHeight(t, lat, lng);
    let rise, set, hMax = h0;

    // go in 2-hour chunks, each time seeing if a 3-point quadratic curve crosses zero (which means rise or set)
    for (let i = 1; i <= 24; i += 2) {
        const h1 = moonHeight(hoursLater(t, i), lat, lng);
        const h2 = moonHeight(hoursLater(t, i + 1), lat, lng);
        hMax = Math.max(hMax, h1, h2);
        const a = (h0 + h2) / 2 - h1;
        const b = (h2 - h0) / 2;
        const xe = -b / (2 * a);
        const d = b * b - 4 * a * h1;
        let roots = 0, x1 = 0, x2 = 0;
        const ye = (a * xe + b) * xe + h1;

        if (d >= 0) {
            const dx = sqrt(d) / (abs(a) * 2);
            x1 = xe - dx;
            x2 = xe + dx;
            if (abs(x1) <= 1) roots++;
            if (abs(x2) <= 1) roots++;
            if (x1 < -1) x1 = x2;
        }

        if (roots === 1) {
            if (h0 < 0) rise = i + x1;
            else set = i + x1;

        } else if (roots === 2) {
            rise = i + (ye < 0 ? x2 : x1);
            set = i + (ye < 0 ? x1 : x2);
        }

        if (rise !== undefined && set !== undefined) break;

        h0 = h2;
    }

    const result = {};

    // compare against undefined, not truthiness: a crossing at exactly hour 0 (midnight) is a real
    // event whose numeric value is 0, which a truthy check would wrongly treat as "no event".
    if (rise !== undefined) result.rise = new Date(refineMoonCross(hoursLater(t, rise).valueOf(), lat, lng));
    if (set !== undefined) result.set = new Date(refineMoonCross(hoursLater(t, set).valueOf(), lat, lng));

    // meridian crossings, reported whether or not the moon is above the horizon at the time
    const lw = rad * -lng;
    const transit = moonTransit(t.valueOf(), lw, 0);
    const lowerTransit = moonTransit(t.valueOf(), lw, PI);
    if (transit !== undefined) result.transit = new Date(transit);
    if (lowerTransit !== undefined) result.lowerTransit = new Date(lowerTransit);

    // no crossing all day: flag which side the moon stays on by testing its highest sampled height
    // against the rise/set threshold (already baked into moonHeight), setting both like getTimes does
    if (rise === undefined && set === undefined) {
        result.alwaysUp = hMax > 0;
        result.alwaysDown = hMax <= 0;
    }

    return result;
}
