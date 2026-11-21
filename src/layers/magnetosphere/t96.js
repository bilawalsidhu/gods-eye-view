/**
 * Tsyganenko T96 external magnetospheric field.
 *
 * Where T89 is keyed to a single ground-disturbance band, T96 is driven by the
 * upstream solar wind directly: dynamic pressure, Dst, and the IMF By and Bz.
 * That buys two things T89 cannot give. The magnetopause is an explicit
 * boundary rather than an implicit one, so the model knows where it stops; and
 * the interconnection field lets southward IMF reconnect through the boundary,
 * which is the mechanism that actually erodes the dayside and loads the tail.
 *
 * Ported from the MIT-licensed Python `geopack` translation of Tsyganenko's
 * Fortran. Unlike T89 this is not one straight-line routine: it is thirty, and
 * the Fortran passed intermediate geometry between them through a COMMON block
 * that each routine re-declared under different names. That block is threaded
 * through here as an explicit `warp` object instead, so the data flow is
 * visible rather than ambient. Everything else is a transliteration, validated
 * against the Python original point by point.
 *
 * Inputs are GSM coordinates in Earth radii and the dipole tilt in radians;
 * output is nT in GSM. Note that T96 returns the *total* external field
 * including its own internal dipole shielding, and that outside the
 * magnetopause it returns the interconnection field minus the dipole, which is
 * what makes the field vanish rather than diverge out there.
 *
 * Reference: Tsyganenko, N. A. (1995), "Modeling the Earth's magnetospheric
 * magnetic field confined within a realistic magnetopause", J. Geophys. Res.,
 * 100, 5599-5612; and Tsyganenko, N. A., and D. P. Stern (1996), "Modeling the
 * global magnetic field of the large-scale Birkeland current systems",
 * J. Geophys. Res., 101, 27187-27198.
 *
 * @module layers/magnetosphere/t96
 */

import { besselJ0, besselJ1 } from './bessel.js';

/**
 * Top-level scaling coefficients: ring-current and tail amplitudes,
 * Birkeland amplitudes and the reconnection efficiency.
 */
const T96_A = Object.freeze([
  1.162, 22.344, 18.5, 2.602, 6.903, 5.287, 0.579, 0.4462, 0.785,
]);

/**
 * Chapman-Ferraro shielding for the perpendicular dipole: six
 * cylindrical-harmonic amplitudes followed by their six scale lengths.
 */
const DIPSHLD_PERP = Object.freeze([
  0.24777, -27.003, -0.46815, 7.0637, -1.5918, -0.090317, 57.522, 13.757, 2.01,
  10.458, 4.5798, 2.1695,
]);

/**
 * Chapman-Ferraro shielding for the parallel dipole, same layout.
 */
const DIPSHLD_PARA = Object.freeze([
  -0.65385, -18.061, -0.40457, -5.0995, 1.2846, 0.078231, 39.592, 13.291, 1.997,
  10.062, 4.514, 2.1558,
]);

/**
 * Shielding coefficients for the ring current: 36 harmonic
 * amplitudes followed by the 12 scales P, R, Q, S.
 */
const RING_CURRENT_SHIELD = Object.freeze([
  -3.087699646, 3.516259114, 18.81380577, -13.95772338, -5.497076303,
  0.1712890838, 2.392629189, -2.728020808, -14.79349936, 11.08738083,
  4.388174084, 0.02492163197, 0.7030375685, -0.7966023165, -3.835041334,
  2.642228681, -0.2405352424, -0.7297705678, -0.3680255045, 0.1333685557,
  2.795140897, -1.078379954, 0.801402863, 0.1245825565, 0.6149982835,
  -0.2207267314, -4.424578723, 1.730471572, -1.716313926, -0.2306302941,
  -0.2450342688, 0.08617173961, 1.54697858, -0.6569391113, -0.6537525353,
  0.2079417515, 12.75434981, 11.37659788, 636.4346279, 1.752483754, 3.604231143,
  12.83078674, 7.412066636, 9.434625736, 676.7557193, 1.701162737, 3.580307144,
  14.64298662,
]);

/**
 * Shielding coefficients for the tail disk, same layout.
 */
const TAIL_DISK_SHIELD = Object.freeze([
  0.8747515218, -0.9116821411, 2.209365387, -2.159059518, -7.059828867,
  5.924671028, -1.916935691, 1.996707344, -3.877101873, 3.947666061,
  11.38715899, -8.343210833, 1.194109867, -1.244316975, 3.73895491,
  -4.406522465, -20.66884863, 3.020952989, 0.2189908481, -0.09942543549,
  -0.927225562, 0.1555224669, 0.6994137909, -0.08111721003, -0.7565493881,
  0.4686588792, 4.266058082, -0.3717470262, -3.920787807, 0.0229856987,
  0.7039506341, -0.5498352719, -6.675140817, 0.8279283559, -2.234773608,
  -1.622656137, 5.187666221, 6.802472048, 39.13543412, 2.784722096, 6.979576616,
  25.7171676, 4.495005873, 8.068408272, 93.47887103, 4.158030104, 9.313492566,
  57.18240483,
]);

/**
 * Shielding coefficients for the asymptotic tail sheet, same layout.
 */
const TAIL_SHEET_SHIELD = Object.freeze([
  -19091.95061, -3011.613928, 20582.16203, 4242.91843, -2377.091102,
  -1504.820043, 19884.0465, 2725.150544, -21389.04845, -3990.475093,
  2401.610097, 1548.171792, -946.5493963, 490.1528941, 986.9156625, -489.326593,
  -67.99278499, 8.71117571, -45.1573426, -10.761065, 210.7927312, 11.41764141,
  -178.0262808, 0.7558830028, 339.3806753, 9.904695974, 69.50583193,
  -118.0271581, 22.85935896, 45.91014857, -425.6607164, 15.47250738,
  118.2988915, 65.58594397, -201.4478068, -14.5706294, 19.6987797, 20.3009568,
  86.4540742, 22.50403727, 23.41617329, 48.48140573, 24.61031329, 123.5395974,
  223.5367692, 39.50824342, 65.83385762, 266.2948657,
]);

/**
 * Ring-current mode amplitudes, pre-multiplied by beta and by -0.43 so
 * the disturbance at the origin normalises to -1 nT.
 */
const RINGCURR_F = Object.freeze([569.895366, -1603.386993]);

/**
 * Ring-current mode scale lengths.
 */
const RINGCURR_BETA = Object.freeze([2.722188, 3.766875]);

/**
 * Tail-disk mode amplitudes, pre-multiplied by beta.
 */
const TAILDISK_F = Object.freeze([
  -745796.7338, 1176470.141, -444610.529, -57508.01028,
]);

/**
 * Tail-disk mode scale lengths.
 */
const TAILDISK_BETA = Object.freeze([7.925, 8.085, 8.47125, 27.895]);

/**
 * Region 1 high-latitude amplitudes: moments of 12 interior dipoles
 * plus two octagonal double loops.
 */
const BIRK1_HIGH_LAT = Object.freeze([
  -0.000911582, -0.00376654, -0.00727423, -0.00270084, -0.00123899, -0.00154387,
  -0.0034004, -0.0191858, -0.0518979, 0.0635061, 0.44068, -0.39657, 0.00561238,
  0.00160938, -0.00451229, -0.0025181, -0.00151599, -0.00133665, -0.000962089,
  -0.0272085, -0.0524319, 0.0717024, 0.523439, -0.405015, -89.5587, 23.2806,
]);

/**
 * Region 1 plasma-sheet amplitudes: 5 conical harmonics plus 74 dipole
 * moment components.
 */
const BIRK1_SHEET = Object.freeze([
  6.04133, 0.305415, 0.00606066, 0.000128379, -1.79406e-5, 1.41714, -27.2586,
  -4.28833, -1.30675, 35.5607, 8.95792, 0.000961617, -0.000801477, -0.000782795,
  -1.65242, -16.5242, -5.33798, 0.000424878, 0.000331787, -0.000704305,
  0.000844342, 9.53682e-5, 0.000886271, 25.112, 20.9299, 5.14569, -44.167,
  -51.0672, -1.87725, 20.2998, 48.7505, -2.97415, 3.35184, -54.2921, -0.838712,
  -10.5123, 70.7594, -4.94104, 0.000106166, 0.000465791, -0.000193719, 10.8439,
  -29.7968, 8.08068, 0.000463507, -2.24475e-5, 0.000177035, -0.000317581,
  -0.000264487, 0.000102075, 7.7139, 10.1915, -4.99797, -23.1114, -29.2043,
  12.2928, 10.9542, 33.6671, -9.3851, 0.000174615, -7.89777e-7, 0.000686047,
  4.60104e-5, -0.00345216, 0.00221871, 0.0110078, -0.00661373, 0.00249201,
  0.0343978, -1.93145e-6, 4.93963e-6, -5.35748e-5, 1.91833e-5, -0.000100496,
  -0.000210103, -0.00232195, 0.00315335, -0.013432, -0.0263222,
]);

/**
 * Region 1 shielding: 64 box-harmonic amplitudes followed by the 16
 * scales P, R, Q, S.
 */
const BIRK1_SHIELD = Object.freeze([
  1.174198045, -1.463820502, 4.840161537, -3.674506864, 82.18368896,
  -94.94071588, -4122.331796, 4670.278676, -21.54975037, 26.72661293,
  -72.81365728, 44.09887902, 40.08073706, -51.2356351, 1955.348537, -1940.97155,
  794.0496433, -982.2441344, 1889.837171, -558.9779727, -1260.543238,
  1260.063802, -293.5942373, 344.7250789, -773.7002492, 957.0094135,
  -1824.143669, 520.7994379, 1192.484774, -1192.184565, 89.15537624,
  -98.52042999, -0.08168777675, 0.04255969908, 0.3155237661, -0.3841755213,
  2.494553332, -0.06571440817, -2.76566131, 0.4331001908, 0.1099181537,
  -0.0615412698, -0.325864926, 0.6698439193, -5.542735524, 0.1604203535,
  5.854456934, -0.8323632049, 3.732608869, -3.130002153, 107.0972607,
  -32.28483411, -115.2389298, 54.4506436, -0.582685332, -3.582482231,
  -4.046544561, 3.311978102, -104.0839563, 30.26401293, 97.29109008,
  -50.62370872, -296.3734955, 127.7872523, 5.303648988, 10.40368955,
  69.65230348, 466.5099509, 1.645049286, 3.82583819, 11.66675599, 558.9781177,
  1.826531343, 2.066018073, 25.40971369, 990.2795225, 2.319489258, 4.555148484,
  9.691185703, 591.8280358,
]);

/**
 * Region 2 shielding: 16 harmonic amplitudes followed by the 8 scales.
 */
const BIRK2_SHIELD = Object.freeze([
  -111.6371348, 124.5402702, 110.3735178, -122.0095905, 111.9448247,
  -129.1957743, -110.7586562, 126.5649012, -0.7865034384, -0.2483462721,
  0.8026023894, 0.2531397188, 10.72890902, 0.8483902118, -10.96884315,
  -0.8583297219, 13.85650567, 14.905545, 10.21914434, 10.09021632, 6.34038246,
  14.40432686, 12.71023437, 12.83966657,
]);

/**
 * Interconnection field: 9 harmonic amplitudes followed by the 6 scales.
 */
const INTERCON = Object.freeze([
  -8.411078731, 5932254.951, -9073284.93, -11.68794634, 6027598.824,
  -9218378.368, -6.508798398, -11824.42793, 18015.66212, 7.99754043, 13.9669886,
  90.24475036, 16.75728834, 1015.645781, 1553.493216,
]);

/**
 * Region 2 sheet, x component.
 */
const R2SHEET_A = Object.freeze([
  8.0719, -7.39582, -7.62341, 0.684671, -13.5672, 11.6681, 13.1154, -0.890217,
  7.78726, -5.38346, -8.08738, 0.609385, -2.7041, 3.53741, 3.15549, -1.11069,
  -8.47555, 0.278122, 2.73514, 4.55625, 13.1134, 1.15848, -3.52648, -8.24698,
  -6.8571, -2.81369, 2.03795, 4.64383, 2.49309, -1.22041, -1.67432, -0.422526,
  -5.39796, 7.10326, 5.5373, -13.1918, 4.67853, -7.60329, -2.53066, 7.76338,
  5.60165, 5.34816, -4.56441, 7.05976, -2.62723, -0.529078, 1.42019, -2.93919,
  55.6338, -1.55181, 39.8311, -80.6561, -46.9655, 32.8925, -6.32296, 19.7841,
  124.731, 10.4347, -30.7581, 102.68, -47.4037, -3.31278, 9.37141, -50.0268,
  -533.319, 110.426, 1000.2, -1051.4, 1619.48, 589.855, -1462.73, 1087.1,
  -1994.73, -1654.12, 1263.33, -260.21, 1424.84, 1255.71, -956.733, 219.946,
]);

/**
 * Region 2 sheet, y component.
 */
const R2SHEET_B = Object.freeze([
  -9.08427, 10.6777, 10.3288, -0.969987, 6.45257, -8.42508, -7.97464, 1.41996,
  -1.9249, 3.93575, 2.83283, -1.48621, 0.244033, -0.757941, -0.386557, 0.344566,
  9.56674, -2.5365, -3.32916, -5.86712, -6.19625, 1.83879, 2.52772, 4.34417,
  1.87268, -2.13213, -1.69134, -0.176379, -0.261359, 0.566419, 0.3138,
  -0.134699, -3.83086, -8.4154, 4.77005, -9.31479, 37.5715, 19.3992, -17.9582,
  36.4604, -14.9993, -3.1442, 6.17409, -15.5519, 2.28621, -0.00891549,
  -0.462912, 2.47314, 41.7555, 208.614, -45.7861, -77.8687, 239.357, -67.9226,
  66.8743, 238.534, -112.136, 16.2069, -40.4706, -134.328, 21.56, -0.201725,
  2.21, 32.5855, -108.217, -1005.98, 585.753, 323.668, -817.056, 235.75,
  -560.965, -576.892, 684.193, 85.0275, 168.394, 477.776, -289.253, -123.216,
  75.6501, -178.605,
]);

/**
 * Region 2 sheet, z component.
 */
const R2SHEET_C = Object.freeze([
  1167.61, -917.782, -1253.2, -274.128, -1538.75, 1257.62, 1745.07, 113.479,
  393.326, -426.858, -641.1, 190.833, -29.9435, -1.04881, 117.125, -25.7663,
  -1168.16, 910.247, 1239.31, 289.515, 1540.56, -1248.29, -1727.61, -131.785,
  -394.577, 426.163, 637.422, -187.965, 30.0348, 0.221898, -116.68, 26.0291,
  12.6804, 4.84091, 1.18166, -2.75946, -17.9822, -6.80357, -1.47134, 3.02266,
  4.79648, 0.665255, -0.256229, -0.0857282, -0.588997, 0.0634812, 0.164303,
  -0.15285, 22.2524, -22.4376, -3.85595, 6.07625, -105.959, -41.6698, 0.378615,
  1.55958, 44.3981, 18.8521, 3.19466, 5.89142, -8.63227, -2.36418, -1.027,
  -2.31515, 1035.38, 2040.66, -131.881, -744.533, -3274.93, -4845.61, 482.438,
  1567.43, 1354.02, 2040.47, -151.653, -845.012, -111.723, -265.343, -26.1171,
  216.632,
]);

/**
 * Region 2 sheet nonlinear parameters, eight each for x, y and z.
 */
const R2SHEET_PNON = Object.freeze([
  -19.0969, -9.28828, -0.129687, 5.58594, 22.5055, 0.048375, 0.0396953,
  0.0579023, -13.675, -6.70625, 2.31875, 11.4062, 20.4562, 0.047875, 0.036375,
  0.05675, -16.7125, -16.4625, -0.1625, 5.1, 23.7125, 0.0355625, 0.031875,
  0.053875,
]);

/**
 * Stretch parameters of the ksi coordinate, then r0 and dr.
 */
const XKSI_STRETCH = Object.freeze([
  0.305662, -0.383593, 0.2677733, -0.097656, -0.636034, -0.359862, 0.424706,
  -0.126366, 0.292578, 1.21563, 7.50937,
]);

/**
 * Region 2 outer linear amplitudes.
 */
const R2OUTER_PL = Object.freeze([
  -34.105, -2.00019, 628.639, 73.4847, 12.5162,
]);

/**
 * Region 2 outer loop geometry.
 */
const R2OUTER_PN = Object.freeze([
  0.55, 0.694, 0.0031, 1.55, 2.8, 0.1375, -0.7, 0.2, 0.9625, -2.994, 2.925,
  -1.775, 4.3, -0.275, 2.7, 0.4312, 1.55,
]);

/**
 * Region 2 inner linear amplitudes.
 */
const R2INNER_PL = Object.freeze([
  154.185, -2.12446, 0.0601735, -0.00153954, 3.55077e-5, 29.9996, 262.886,
  99.9132,
]);

/**
 * Region 2 inner loop geometry.
 */
const R2INNER_PN = Object.freeze([
  -8.1902, 6.5239, 5.504, 7.7815, 0.8573, 3.0986, 0.0774, -0.038,
]);

/**
 * x positions of the 12 interior dipoles, in units of dipx.
 */
const BIRK1_XX1 = Object.freeze([-11, -7, -7, -3, -3, 1, 1, 1, 5, 5, 9, 9]);

/**
 * y positions of the 12 interior dipoles, in units of dipy. The zeros
 * mark dipoles that sit on the noon-midnight meridian and so have no mirror.
 */
const BIRK1_YY1 = Object.freeze([2, 0, 4, 2, 6, 0, 4, 8, 2, 6, 0, 4]);

/**
 * x positions of the plasma-sheet dipoles.
 */
const BIRK1_XX2 = Object.freeze([
  -10, -7, -4, -4, 0, 4, 4, 7, 10, 0, 0, 0, 0, 0,
]);

/**
 * y positions of the plasma-sheet dipoles.
 */
const BIRK1_YY2 = Object.freeze([3, 6, 3, 9, 6, 3, 9, 6, 3, 0, 0, 0, 0, 0]);

/**
 * z positions of the plasma-sheet dipoles; the last five are the z-axis
 * line sources.
 */
const BIRK1_ZZ2 = Object.freeze([
  20, 20, 4, 20, 4, 4, 20, 20, 20, 2, 3, 4.5, 7, 10,
]);

/** Earth's dipole moment in the units this model works in (nT * Re^3). */
const DIPOLE_MOMENT = 30574;

/** Hinging distance and transition scale of the tail-sheet warping, in Re. */
const HINGE_DISTANCE = 9;
const HINGE_TRANSITION = 4;

/**
 * Field of the geodipole itself, tilted by ps.
 *
 * T96 adds this back in outside the magnetopause so the two cancel, leaving
 * only the interconnection field. Identical to the routine T89 uses.
 *
 * @param {number} ps Dipole tilt in radians.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function dipole(ps, x, y, z) {
  const sps = Math.sin(ps);
  const cps = Math.cos(ps);
  const p = x * x;
  const u = z * z;
  const v = 3 * z * x;
  const t = y * y;
  const q = DIPOLE_MOMENT / Math.sqrt(p + t + u) ** 5;
  return [
    q * ((t + u - 2 * p) * sps - v * cps),
    -3 * y * q * (x * sps + z * cps),
    q * ((p + t - 2 * u) * cps - v * sps),
  ];
}

/**
 * Fields of three unit dipoles at the origin, aligned with x, y and z.
 *
 * The Birkeland modules build their current systems out of many such dipoles,
 * and need all three orientations at every site, so all nine components come
 * back from one radius computation.
 *
 * @param {number} x Offset from the dipole, in Re.
 * @param {number} y Offset from the dipole, in Re.
 * @param {number} z Offset from the dipole, in Re.
 * @returns {number[]} [bxx, byx, bzx, bxy, byy, bzy, bxz, byz, bzz] in nT.
 */
function dipxyz(x, y, z) {
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  const r2 = x2 + y2 + z2;

  const xmr5 = DIPOLE_MOMENT / (r2 * r2 * Math.sqrt(r2));
  const xmr53 = 3 * xmr5;
  const bxx = xmr5 * (3 * x2 - r2);
  const byx = xmr53 * x * y;
  const bzx = xmr53 * x * z;
  const byy = xmr5 * (3 * y2 - r2);
  const bzy = xmr53 * y * z;
  const bzz = xmr5 * (3 * z2 - r2);

  // The off-diagonal terms are symmetric, so bxy == byx and bxz == bzx.
  return [bxx, byx, bzx, byx, byy, bzy, bzx, bzy, bzz];
}

/**
 * Field of a circular current loop of radius rl centred on the origin, with its
 * axis along z.
 *
 * Uses the second, more accurate polynomial approximation to the complete
 * elliptic integrals K and E given in Abramowitz and Stegun.
 *
 * @param {number} x Position in Re.
 * @param {number} y Position in Re.
 * @param {number} z Position in Re.
 * @param {number} rl Loop radius in Re.
 * @returns {number[]} [bx, by, bz], unnormalised.
 */
function circle(x, y, z, rl) {
  const rho2 = x * x + y * y;
  const rho = Math.sqrt(rho2);
  const r22 = z * z + (rho + rl) ** 2;
  const r2 = Math.sqrt(r22);
  const r12 = r22 - 4 * rho * rl;
  const r32 = 0.5 * (r12 + r22);
  const xk2 = 1 - r12 / r22;
  const xk2s = 1 - xk2;
  const dl = Math.log(1 / xk2s);

  const k =
    1.38629436112 +
    xk2s *
      (0.09666344259 +
        xk2s *
          (0.03590092383 + xk2s * (0.03742563713 + xk2s * 0.01451196212))) +
    dl *
      (0.5 +
        xk2s *
          (0.12498593597 +
            xk2s *
              (0.06880248576 + xk2s * (0.03328355346 + xk2s * 0.00441787012))));
  const e =
    1 +
    xk2s *
      (0.44325141463 +
        xk2s * (0.0626060122 + xk2s * (0.04757383546 + xk2s * 0.01736506451))) +
    dl *
      xk2s *
      (0.2499836831 +
        xk2s * (0.09200180037 + xk2s * (0.04069697526 + xk2s * 0.00526449639)));

  // Not quite B_rho: it carries an extra division by rho so that the cartesian
  // components below are a plain multiplication.
  const brho =
    rho > 1e-6
      ? (z / (rho2 * r2)) * ((r32 / r12) * e - k)
      : (((Math.PI * rl) / r2) * (rl - rho) * z) / (r12 * (r32 - rho2));

  return [brho * x, brho * y, (k - (e * (r32 - 2 * rl * rl)) / r12) / r2];
}

/**
 * Field of a pair of loops sharing a centre and a diameter along x, inclined to
 * the equatorial plane by al and shifted downtail by xc.
 *
 * @param {number} x Position in Re.
 * @param {number} y Position in Re.
 * @param {number} z Position in Re.
 * @param {number} xc Shift of the common centre along x, in Re.
 * @param {number} rl Loop radius in Re.
 * @param {number} al Inclination to the equator in radians.
 * @returns {number[]} [bx, by, bz], unnormalised.
 */
function crosslp(x, y, z, xc, rl, al) {
  const cal = Math.cos(al);
  const sal = Math.sin(al);

  const y1 = y * cal - z * sal;
  const z1 = y * sal + z * cal;
  const y2 = y * cal + z * sal;
  const z2 = -y * sal + z * cal;
  const [bx1, by1, bz1] = circle(x - xc, y1, z1, rl);
  const [bx2, by2, bz2] = circle(x - xc, y2, z2, rl);

  return [
    bx1 + bx2,
    (by1 + by2) * cal + (bz1 - bz2) * sal,
    -(by1 - by2) * sal + (bz1 + bz2) * cal,
  ];
}

/**
 * Field of four current loops placed symmetrically about the noon-midnight
 * meridian and the equatorial plane.
 *
 * @param {number} x Position in Re.
 * @param {number} y Position in Re.
 * @param {number} z Position in Re.
 * @param {number} xc Centre of the first-quadrant loop, x in Re.
 * @param {number} yc Centre of the first-quadrant loop, y in Re (positive).
 * @param {number} zc Centre of the first-quadrant loop, z in Re (positive).
 * @param {number} r Loop radius in Re, common to all four.
 * @param {number} theta Polar angle of the first loop's normal, in radians.
 * @param {number} phi Azimuth of the first loop's normal, in radians.
 * @returns {number[]} [bx, by, bz], unnormalised.
 */
function loops4(x, y, z, xc, yc, zc, r, theta, phi) {
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);

  /**
   * One loop, reached by rotating into its frame and back out again.
   *
   * @param {number} xs Along the loop's azimuth, before the polar rotation.
   * @param {number} yss Across it.
   * @param {number} zs Offset along z.
   * @returns {number[]} [bxs, bys, bz] in the half-rotated frame.
   */
  const quadrant = (xs, yss, zs) => {
    const xss = xs * ct - zs * st;
    const zss = zs * ct + xs * st;
    const [bxss, bys, bzss] = circle(xss, yss, zss, r);
    return [bxss * ct + bzss * st, bys, bzss * ct - bxss * st];
  };

  const [bxs1, bys1, bz1] = quadrant(
    (x - xc) * cp + (y - yc) * sp,
    (y - yc) * cp - (x - xc) * sp,
    z - zc,
  );
  const bx1 = bxs1 * cp - bys1 * sp;
  const by1 = bxs1 * sp + bys1 * cp;

  const [bxs2, bys2, bz2] = quadrant(
    (x - xc) * cp - (y + yc) * sp,
    (y + yc) * cp + (x - xc) * sp,
    z - zc,
  );
  const bx2 = bxs2 * cp + bys2 * sp;
  const by2 = -bxs2 * sp + bys2 * cp;

  const [bxs3, bys3, bz3] = quadrant(
    -(x - xc) * cp + (y + yc) * sp,
    -(y + yc) * cp - (x - xc) * sp,
    z + zc,
  );
  const bx3 = -bxs3 * cp - bys3 * sp;
  const by3 = bxs3 * sp - bys3 * cp;

  const [bxs4, bys4, bz4] = quadrant(
    -(x - xc) * cp - (y - yc) * sp,
    -(y - yc) * cp + (x - xc) * sp,
    z + zc,
  );
  const bx4 = -bxs4 * cp + bys4 * sp;
  const by4 = -bxs4 * sp - bys4 * cp;

  return [bx1 + bx2 + bx3 + bx4, by1 + by2 + by3 + by4, bz1 + bz2 + bz3 + bz4];
}

/** Below this cylindrical radius the azimuth is degenerate and gets pinned. */
const AXIS_EPSILON = 1e-8;

/**
 * Shielding field of the perpendicular dipole, as six cylindrical harmonics.
 *
 * @param {readonly number[]} a Six amplitudes then six scale lengths.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function cylharm(a, x, y, z) {
  let rho = Math.sqrt(y * y + z * z);
  let sinfi;
  let cosfi;
  if (rho < AXIS_EPSILON) {
    sinfi = 1;
    cosfi = 0;
    rho = AXIS_EPSILON;
  } else {
    sinfi = z / rho;
    cosfi = y / rho;
  }

  const sinfi2 = sinfi * sinfi;
  const si2co2 = sinfi2 - cosfi * cosfi;

  let bx = 0;
  let by = 0;
  let bz = 0;

  for (let i = 0; i < 3; i += 1) {
    const dzeta = rho / a[i + 6];
    const xksiTerm = x / a[i + 6];
    const xj0 = besselJ0(dzeta);
    const xj1 = besselJ1(dzeta);
    const xexp = Math.exp(xksiTerm);
    bx -= a[i] * xj1 * xexp * sinfi;
    by += a[i] * ((2 * xj1) / dzeta - xj0) * xexp * sinfi * cosfi;
    bz += a[i] * ((xj1 / dzeta) * si2co2 - xj0 * sinfi2) * xexp;
  }

  for (let i = 3; i < 6; i += 1) {
    const dzeta = rho / a[i + 6];
    const xksiTerm = x / a[i + 6];
    const xj0 = besselJ0(dzeta);
    const xj1 = besselJ1(dzeta);
    const xexp = Math.exp(xksiTerm);
    const brho =
      (xksiTerm * xj0 - ((dzeta * dzeta + xksiTerm - 1) * xj1) / dzeta) *
      xexp *
      sinfi;
    const bphi = (xj0 + (xj1 / dzeta) * (xksiTerm - 1)) * xexp * cosfi;
    bx += a[i] * (dzeta * xj0 + xksiTerm * xj1) * xexp * sinfi;
    by += a[i] * (brho * cosfi - bphi * sinfi);
    bz += a[i] * (brho * sinfi + bphi * cosfi);
  }

  return [bx, by, bz];
}

/**
 * Shielding field of the parallel dipole, as six cylindrical harmonics.
 *
 * @param {readonly number[]} a Six amplitudes then six scale lengths.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function cylhar1(a, x, y, z) {
  let rho = Math.sqrt(y * y + z * z);
  let sinfi;
  let cosfi;
  if (rho < AXIS_EPSILON) {
    sinfi = 1;
    cosfi = 0;
    rho = AXIS_EPSILON;
  } else {
    sinfi = z / rho;
    cosfi = y / rho;
  }

  let bx = 0;
  let by = 0;
  let bz = 0;

  for (let i = 0; i < 3; i += 1) {
    const dzeta = rho / a[i + 6];
    const xksiTerm = x / a[i + 6];
    const xj0 = besselJ0(dzeta);
    const xj1 = besselJ1(dzeta);
    const xexp = Math.exp(xksiTerm);
    const brho = xj1 * xexp;
    bx -= a[i] * xj0 * xexp;
    by += a[i] * brho * cosfi;
    bz += a[i] * brho * sinfi;
  }

  for (let i = 3; i < 6; i += 1) {
    const dzeta = rho / a[i + 6];
    const xksiTerm = x / a[i + 6];
    const xj0 = besselJ0(dzeta);
    const xj1 = besselJ1(dzeta);
    const xexp = Math.exp(xksiTerm);
    const brho = (dzeta * xj0 + xksiTerm * xj1) * xexp;
    bx += a[i] * (dzeta * xj1 - xj0 * (xksiTerm + 1)) * xexp;
    by += a[i] * brho * cosfi;
    bz += a[i] * brho * sinfi;
  }

  return [bx, by, bz];
}

/**
 * Chapman-Ferraro field: the external field due to shielding of the geodipole
 * alone, with the perpendicular and parallel parts weighted by the tilt.
 *
 * @param {number} ps Dipole tilt in radians.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function dipshld(ps, x, y, z) {
  const cps = Math.cos(ps);
  const sps = Math.sin(ps);
  const [hx, hy, hz] = cylharm(DIPSHLD_PERP, x, y, z);
  const [fx, fy, fz] = cylhar1(DIPSHLD_PARA, x, y, z);
  return [hx * cps + fx * sps, hy * cps + fy * sps, hz * cps + fz * sps];
}

/**
 * Shielding field as 2x3x3 = 18 cartesian harmonics, each contributing a pair
 * of amplitudes: one flat and one weighted by the tilt.
 *
 * @param {readonly number[]} a 36 amplitudes then the 12 scales P, R, Q, S.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @param {number} sps Sine of the dipole tilt.
 * @returns {number[]} [hx, hy, hz] in nT.
 */
function shlcar3x3(a, x, y, z, sps) {
  const cps = Math.sqrt(1 - sps * sps);
  // sin(3 ps) / sin(ps), which stays finite as the tilt goes to zero.
  const s3ps = 4 * cps * cps - 1;

  let hx = 0;
  let hy = 0;
  let hz = 0;
  let l = 0;

  // m = 0 is the perpendicular-symmetry sum, m = 1 the parallel one.
  for (let m = 0; m < 2; m += 1) {
    for (let i = 0; i < 3; i += 1) {
      const p = a[36 + i];
      const q = a[42 + i];
      const cypi = Math.cos(y / p);
      const cyqi = Math.cos(y / q);
      const sypi = Math.sin(y / p);
      const syqi = Math.sin(y / q);
      for (let k = 0; k < 3; k += 1) {
        const r = a[39 + k];
        const s = a[45 + k];
        const szrk = Math.sin(z / r);
        const czsk = Math.cos(z / s);
        const czrk = Math.cos(z / r);
        const szsk = Math.sin(z / s);
        const sqpr = Math.sqrt(1 / (p * p) + 1 / (r * r));
        const sqqs = Math.sqrt(1 / (q * q) + 1 / (s * s));
        const epr = Math.exp(x * sqpr);
        const eqs = Math.exp(x * sqqs);
        // The n = 1 pass reuses the harmonic the n = 0 pass built, scaled by
        // the tilt factor, so these have to outlive the inner loop.
        let dx = 0;
        let dy = 0;
        let dz = 0;
        for (let n = 0; n < 2; n += 1) {
          if (m === 0) {
            if (n === 0) {
              dx = -sqpr * epr * cypi * szrk;
              dy = (epr / p) * sypi * szrk;
              dz = (-epr / r) * cypi * czrk;
            } else {
              dx *= cps;
              dy *= cps;
              dz *= cps;
            }
          } else if (n === 0) {
            dx = -sps * sqqs * eqs * cyqi * czsk;
            dy = ((sps * eqs) / q) * syqi * czsk;
            dz = ((sps * eqs) / s) * cyqi * szsk;
          } else {
            dx *= s3ps;
            dy *= s3ps;
            dz *= s3ps;
          }
          hx += a[l] * dx;
          hy += a[l] * dy;
          hz += a[l] * dz;
          l += 1;
        }
      }
    }
  }

  return [hx, hy, hz];
}

/**
 * @typedef {object} SheetGeometry
 * The warped current-sheet geometry, shared by the ring current and both tail
 * modes. This is the Fortran COMMON /WARP/ block, made explicit. Each routine
 * downstream reads a different subset, and the ring current deliberately
 * recomputes some of it without the y-z warping.
 * @property {number} cpss Cosine of the local sheet tilt.
 * @property {number} spss Sine of the local sheet tilt.
 * @property {number} dpsrr Radial derivative of that tilt.
 * @property {number} rps Tilt-dependent shift of the asymptotic sheet along z.
 * @property {number} warp Bending of the sheet flanks along z.
 * @property {number} d Sheet half-thickness for the tail modes, in Re.
 * @property {number} xs Sheet-aligned x.
 * @property {number} zs Height above the sheet, with the y-z warp.
 * @property {number} zsww Height above the sheet, without the y-z warp.
 * @property {number} dxsx Derivative of xs with respect to x.
 * @property {number} dxsy Derivative of xs with respect to y.
 * @property {number} dxsz Derivative of xs with respect to z.
 * @property {number} dzsx Derivative of zs with respect to x.
 * @property {number} dzsy Derivative of zs with respect to y.
 * @property {number} dzsz Derivative of zs with respect to z.
 * @property {number} dzetas Spread-out distance from the sheet.
 * @property {number} ddzetadx Derivative of dzetas with respect to x.
 * @property {number} ddzetady Derivative of dzetas with respect to y.
 * @property {number} ddzetadz Derivative of dzetas with respect to z.
 */

/**
 * Ring-current field, following Tsyganenko and Peredo (1994) but space-warped
 * rather than sheared, and reduced to two terms.
 *
 * The second term comes out as an eastward current earthward of the main one,
 * which is what spacecraft actually see.
 *
 * @param {SheetGeometry} sheet Shared sheet geometry from tailrc96.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT, normalised to bz = -1 nT at origin.
 */
function ringcurr96(sheet, x, y, z) {
  const { cpss, spss, dpsrr, xs, dxsx, dxsy, dxsz, dzsx, dzsz, zsww } = sheet;
  // deltadx is zero: the ring current is completely symmetric, so d is flat and
  // dddx vanishes. Both are kept so the shape matches the published routine.
  const d0 = 2;
  const deltadx = 0;
  const xd = 0;
  const xldx = 4;

  // The ring current is warped along x only, so dzsy is recomputed here without
  // the y-z term that tailrc96 put in the shared value.
  const dzsy = xs * y * dpsrr;
  const xxd = x - xd;
  const fdx = 0.5 * (1 + xxd / Math.sqrt(xxd * xxd + xldx * xldx));
  const dddx =
    (deltadx * 0.5 * xldx * xldx) / Math.sqrt(xxd * xxd + xldx * xldx) ** 3;
  const d = d0 + deltadx * fdx;

  const zs = zsww;
  const dzetas = Math.sqrt(zs * zs + d * d);
  const rhos = Math.sqrt(xs * xs + y * y);
  const ddzetadx = (zs * dzsx + d * dddx) / dzetas;
  const ddzetady = (zs * dzsy) / dzetas;
  const ddzetadz = (zs * dzsz) / dzetas;

  let drhosdx;
  let drhosdy;
  let drhosdz;
  if (rhos < 1e-5) {
    drhosdx = 0;
    drhosdy = Math.sign(y);
    drhosdz = 0;
  } else {
    drhosdx = (xs * dxsx) / rhos;
    drhosdy = (xs * dxsy + y) / rhos;
    drhosdz = (xs * dxsz) / rhos;
  }

  let bx = 0;
  let by = 0;
  let bz = 0;

  for (let i = 0; i < 2; i += 1) {
    const bi = RINGCURR_BETA[i];
    const { as0, dasdx, dasdy, dasdz } = sheetModeTerm(
      bi,
      dzetas,
      rhos,
      [ddzetadx, ddzetady, ddzetadz],
      [drhosdx, drhosdy, drhosdz],
    );
    const f = RINGCURR_F[i];
    bx +=
      f *
      ((2 * as0 + y * dasdy) * spss -
        xs * dasdz +
        as0 * dpsrr * (y * y * cpss + z * zs));
    by -= f * y * (as0 * dpsrr * xs + dasdz * cpss + dasdx * spss);
    bz +=
      f *
      ((2 * as0 + y * dasdy) * cpss +
        xs * dasdx -
        as0 * dpsrr * (x * zs + y * y * spss));
  }

  return [bx, by, bz];
}

/**
 * The vector potential term and its gradient for one spread-out sheet mode.
 *
 * The ring current and the tail disk build their fields from the same
 * expression, differing only in the radial coordinate and the amplitudes, so it
 * is factored out here rather than written twice.
 *
 * @param {number} bi Mode scale length in Re.
 * @param {number} dzetas Spread-out distance from the sheet.
 * @param {number} rhos Cylindrical radius in the sheet frame.
 * @param {number[]} dDzetas Gradient of dzetas, as [d/dx, d/dy, d/dz].
 * @param {number[]} dRhos Gradient of rhos, as [d/dx, d/dy, d/dz].
 * @returns {{as0: number, dasdx: number, dasdy: number, dasdz: number}} The
 *   term and its three derivatives.
 */
function sheetModeTerm(bi, dzetas, rhos, dDzetas, dRhos) {
  const [ddzetadx, ddzetady, ddzetadz] = dDzetas;
  const [drhosdx, drhosdy, drhosdz] = dRhos;

  const s1 = Math.sqrt((dzetas + bi) ** 2 + (rhos + bi) ** 2);
  const s2 = Math.sqrt((dzetas + bi) ** 2 + (rhos - bi) ** 2);
  const ds1ddz = (dzetas + bi) / s1;
  const ds2ddz = (dzetas + bi) / s2;
  const ds1drhos = (rhos + bi) / s1;
  const ds2drhos = (rhos - bi) / s2;

  const ds1dx = ds1ddz * ddzetadx + ds1drhos * drhosdx;
  const ds1dy = ds1ddz * ddzetady + ds1drhos * drhosdy;
  const ds1dz = ds1ddz * ddzetadz + ds1drhos * drhosdz;

  const ds2dx = ds2ddz * ddzetadx + ds2drhos * drhosdx;
  const ds2dy = ds2ddz * ddzetady + ds2drhos * drhosdy;
  const ds2dz = ds2ddz * ddzetadz + ds2drhos * drhosdz;

  const s1ts2 = s1 * s2;
  const s1ps2 = s1 + s2;
  const s1ps2sq = s1ps2 * s1ps2;
  const fac1 = Math.sqrt(s1ps2sq - (2 * bi) ** 2);
  const as0 = fac1 / (s1ts2 * s1ps2sq);
  const term1 = 1 / (s1ts2 * s1ps2 * fac1);
  const fac2 = as0 / s1ps2sq;
  const dasds1 = term1 - (fac2 / s1) * (s2 * s2 + s1 * (3 * s1 + 4 * s2));
  const dasds2 = term1 - (fac2 / s2) * (s1 * s1 + s2 * (3 * s2 + 4 * s1));

  return {
    as0,
    dasdx: dasds1 * ds1dx + dasds2 * ds2dx,
    dasdy: dasds1 * ds1dy + dasds2 * ds2dy,
    dasdz: dasds1 * ds1dz + dasds2 * ds2dz,
  };
}

/**
 * Tail-disk field: the near tail current, as four space-warped modes.
 *
 * Unlike the ring current this uses the shared sheet geometry as-is, including
 * the y-z warping, and its radial coordinate is shifted downtail.
 *
 * @param {SheetGeometry} sheet Shared sheet geometry from tailrc96.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function taildisk(sheet, x, y, z) {
  const {
    cpss,
    spss,
    dpsrr,
    xs,
    dxsx,
    dxsy,
    dxsz,
    dzetas,
    ddzetadx,
    ddzetady,
    ddzetadz,
    zsww,
  } = sheet;
  const xshift = 4.5;

  const rhos = Math.sqrt((xs - xshift) ** 2 + y * y);
  let drhosdx;
  let drhosdy;
  let drhosdz;
  if (rhos < 1e-5) {
    drhosdx = 0;
    drhosdy = Math.sign(y);
    drhosdz = 0;
  } else {
    drhosdx = ((xs - xshift) * dxsx) / rhos;
    drhosdy = ((xs - xshift) * dxsy + y) / rhos;
    drhosdz = ((xs - xshift) * dxsz) / rhos;
  }

  let bx = 0;
  let by = 0;
  let bz = 0;

  for (let i = 0; i < 4; i += 1) {
    const { as0, dasdx, dasdy, dasdz } = sheetModeTerm(
      TAILDISK_BETA[i],
      dzetas,
      rhos,
      [ddzetadx, ddzetady, ddzetadz],
      [drhosdx, drhosdy, drhosdz],
    );
    const f = TAILDISK_F[i];
    bx +=
      f *
      ((2 * as0 + y * dasdy) * spss -
        (xs - xshift) * dasdz +
        as0 * dpsrr * (y * y * cpss + z * zsww));
    by -= f * y * (as0 * dpsrr * xs + dasdz * cpss + dasdx * spss);
    bz +=
      f *
      ((2 * as0 + y * dasdy) * cpss +
        (xs - xshift) * dasdx -
        as0 * dpsrr * (x * zsww + y * y * spss));
  }

  return [bx, by, bz];
}

/**
 * Half of pi, as the published Fortran spells it.
 *
 * Deliberately not Math.PI / 2. The 1987 tail model's coefficients were fitted
 * against this seven-digit constant, and swapping in the exact value shifts the
 * mode's output in the last few digits for no gain in fidelity.
 */
const TAIL87_HALF_PI = 1.5707963;

/**
 * Asymptotic tail mode: the long version of the 1987 tail field.
 *
 * Three sheets - the central one plus images at z = +/- rt - give the field a
 * finite extent in z. Axisymmetric in the sense that it has no y dependence of
 * its own; the y dependence arrives through the warp terms in `sheet`.
 *
 * @param {SheetGeometry} sheet Shared sheet geometry; only rps and warp are read.
 * @param {number} x GSM x in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, bz] in nT, normalised to bx = 1 nT at x = -200 Re.
 */
function tail87(sheet, x, z) {
  const { rps, warp } = sheet;
  // Total half-thickness of this mode, fixed at 3 Re rather than taken from the
  // shared geometry.
  const dd = 3;
  // z of the upper and lower image sheets, and the inner edge of the current.
  const rt = 40;
  const xn = -10;
  const x1 = -1.261;
  const x2 = -0.663;
  // Mode amplitudes, normalised so the asymptotic bx is 1 nT at x = -200 Re.
  // These are the tscale = 1 values, not the older tscale = 0.6 ones.
  const b0 = 0.391734;
  const b1 = 5.89715;
  const b2 = 24.6833;

  const xn21 = (xn - x1) ** 2;
  const xnr = 1 / (xn - x2);
  const adln = -Math.log(xnr * xnr * xn21);

  const zs = z - rps + warp;
  const zp = z - rt;
  const zm = z + rt;

  const xnx = xn - x;
  const xnx2 = xnx * xnx;
  const xc1 = x - x1;
  const xc2 = x - x2;
  const xc22 = xc2 * xc2;
  const xr2 = xc2 * xnr;
  const xc12 = xc1 * xc1;
  const d2 = dd * dd;
  const b20 = zs * zs + d2;
  const b2p = zp * zp + d2;
  const b2m = zm * zm + d2;
  const b = Math.sqrt(b20);
  const bp = Math.sqrt(b2p);
  const bm = Math.sqrt(b2m);
  const xa1 = xc12 + b20;
  const xap1 = xc12 + b2p;
  const xam1 = xc12 + b2m;
  const xa2 = 1 / (xc22 + b20);
  const xap2 = 1 / (xc22 + b2p);
  const xam2 = 1 / (xc22 + b2m);
  const xna = xnx2 + b20;
  const xnap = xnx2 + b2p;
  const xnam = xnx2 + b2m;
  const f = b20 - xc22;
  const fp = b2p - xc22;
  const fm = b2m - xc22;
  const xln1 = Math.log(xn21 / xna);
  const xlnp1 = Math.log(xn21 / xnap);
  const xlnm1 = Math.log(xn21 / xnam);
  const xln2 = xln1 + adln;
  const xlnp2 = xlnp1 + adln;
  const xlnm2 = xlnm1 + adln;
  const aln = 0.25 * (xlnp1 + xlnm1 - 2 * xln1);
  const s0 = (Math.atan(xnx / b) + TAIL87_HALF_PI) / b;
  const s0p = (Math.atan(xnx / bp) + TAIL87_HALF_PI) / bp;
  const s0m = (Math.atan(xnx / bm) + TAIL87_HALF_PI) / bm;
  const s1 = (xln1 * 0.5 + xc1 * s0) / xa1;
  const s1p = (xlnp1 * 0.5 + xc1 * s0p) / xap1;
  const s1m = (xlnm1 * 0.5 + xc1 * s0m) / xam1;
  const s2 = (xc2 * xa2 * xln2 - xnr - f * xa2 * s0) * xa2;
  const s2p = (xc2 * xap2 * xlnp2 - xnr - fp * xap2 * s0p) * xap2;
  const s2m = (xc2 * xam2 * xlnm2 - xnr - fm * xam2 * s0m) * xam2;
  const g1 = (b20 * s0 - 0.5 * xc1 * xln1) / xa1;
  const g1p = (b2p * s0p - 0.5 * xc1 * xlnp1) / xap1;
  const g1m = (b2m * s0m - 0.5 * xc1 * xlnm1) / xam1;
  const g2 = ((0.5 * f * xln2 + 2 * s0 * b20 * xc2) * xa2 + xr2) * xa2;
  const g2p = ((0.5 * fp * xlnp2 + 2 * s0p * b2p * xc2) * xap2 + xr2) * xap2;
  const g2m = ((0.5 * fm * xlnm2 + 2 * s0m * b2m * xc2) * xam2 + xr2) * xam2;

  const bx =
    b0 * (zs * s0 - 0.5 * (zp * s0p + zm * s0m)) +
    b1 * (zs * s1 - 0.5 * (zp * s1p + zm * s1m)) +
    b2 * (zs * s2 - 0.5 * (zp * s2p + zm * s2m));
  const bz =
    b0 * aln + b1 * (g1 - 0.5 * (g1p + g1m)) + b2 * (g2 - 0.5 * (g2p + g2m));

  return [bx, bz];
}

/**
 * Ring current and the three tail modes, each with unit amplitude, plus their
 * shielding fields.
 *
 * The expensive part is the warped sheet geometry, which all four share, so it
 * is computed once here and handed down.
 *
 * @param {number} sps Sine of the dipole tilt.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {{ringCurrent: number[], tailDisk: number[], tailSheet: number[]}}
 *   Three [bx, by, bz] triples in nT.
 */
function tailrc96(sps, x, y, z) {
  const rh = HINGE_DISTANCE;
  const dr = HINGE_TRANSITION;
  // Warping gain, sheet half-thickness at the midnight meridian, and the rate
  // at which it thickens toward the flanks.
  const g = 10;
  const d0 = 2;
  const deltady = 10;

  const dr2 = dr * dr;
  const c11 = Math.sqrt((1 + rh) ** 2 + dr2);
  const c12 = Math.sqrt((1 - rh) ** 2 + dr2);
  const c1 = c11 - c12;
  const spsc1 = sps / c1;
  // Shift of the sheet away from the GSM equator for the asymptotic tail mode.
  const rps = 0.5 * (c11 + c12) * sps;

  const r = Math.sqrt(x * x + y * y + z * z);
  const sq1 = Math.sqrt((r + rh) ** 2 + dr2);
  const sq2 = Math.sqrt((r - rh) ** 2 + dr2);
  const c = sq1 - sq2;
  const cs = (r + rh) / sq1 - (r - rh) / sq2;
  const spss = (spsc1 / r) * c;
  const cpss = Math.sqrt(1 - spss * spss);
  const dpsrr =
    ((sps / (r * r)) * (cs * r - c)) /
    Math.sqrt((r * c1) ** 2 - (c * sps) ** 2);

  const wfac = y / (y ** 4 + 1e4);
  const w = wfac * y ** 3;
  const ws = 4e4 * y * wfac * wfac;
  const warp = g * sps * w;
  const xs = x * cpss - z * spss;
  const zsww = z * cpss + x * spss;
  const zs = zsww + warp;

  const dxsx = cpss - x * zsww * dpsrr;
  const dxsy = -y * zsww * dpsrr;
  const dxsz = -spss - z * zsww * dpsrr;
  const dzsx = spss + x * xs * dpsrr;
  // The trailing term is the y-z warp, which the tail modes want and the ring
  // current does not.
  const dzsy = xs * y * dpsrr + g * sps * ws;
  const dzsz = cpss + xs * z * dpsrr;

  // Thickens toward the flanks, but with no variation along x, unlike the ring
  // current's half-thickness.
  const d = d0 + deltady * (y / 20) ** 2;
  const dddy = deltady * y * 0.005;

  // Same way of spreading the sheet out as T89 uses.
  const dzetas = Math.sqrt(zs * zs + d * d);
  const ddzetadx = (zs * dzsx) / dzetas;
  const ddzetady = (zs * dzsy + d * dddy) / dzetas;
  const ddzetadz = (zs * dzsz) / dzetas;

  /** @type {SheetGeometry} */
  const sheet = {
    cpss,
    spss,
    dpsrr,
    rps,
    warp,
    d,
    xs,
    zs,
    zsww,
    dxsx,
    dxsy,
    dxsz,
    dzsx,
    dzsy,
    dzsz,
    dzetas,
    ddzetadx,
    ddzetady,
    ddzetadz,
  };

  const [wx1, wy1, wz1] = shlcar3x3(RING_CURRENT_SHIELD, x, y, z, sps);
  const [hx1, hy1, hz1] = ringcurr96(sheet, x, y, z);

  const [wx2, wy2, wz2] = shlcar3x3(TAIL_DISK_SHIELD, x, y, z, sps);
  const [hx2, hy2, hz2] = taildisk(sheet, x, y, z);

  const [wx3, wy3, wz3] = shlcar3x3(TAIL_SHEET_SHIELD, x, y, z, sps);
  const [hx3, hz3] = tail87(sheet, x, z);

  return {
    ringCurrent: [wx1 + hx1, wy1 + hy1, wz1 + hz1],
    tailDisk: [wx2 + hx2, wy2 + hy2, wz2 + hz2],
    // The 1987 mode has no by of its own, so only the shielding contributes.
    tailSheet: [wx3 + hx3, wy3, wz3 + hz3],
  };
}

/**
 * The stretched coordinate ksi, which measures where a point sits relative to
 * the region 2 current sheet.
 *
 * Negative is outside the sheet, positive inside; r2_birk switches between its
 * three field representations on the sign and magnitude of this.
 *
 * @param {number} x SM x in Re.
 * @param {number} y SM y in Re.
 * @param {number} z SM z in Re.
 * @returns {number} The stretched coordinate, dimensionless.
 */
function xksi(x, y, z) {
  const [
    a11a12,
    a21a22,
    a41a42,
    a51a52,
    a61a62,
    b11b12,
    b21b22,
    c61c62,
    c71c72,
    r0,
    dr,
  ] = XKSI_STRETCH;
  // Noon and midnight latitudes of 69 and 63.5 degrees respectively.
  const tnoon = 0.3665191;
  const dteta = 0.09599309;

  const dr2 = dr * dr;
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  const xr = x / r;
  const yr = y / r;
  const zr = z / r;

  const pr = r < r0 ? 0 : Math.sqrt((r - r0) ** 2 + dr2) - dr;

  const f =
    x +
    pr *
      (a11a12 +
        a21a22 * xr +
        a41a42 * xr * xr +
        a51a52 * yr * yr +
        a61a62 * zr * zr);
  const g = y + pr * (b11b12 * yr + b21b22 * xr * yr);
  const h = z + pr * (c61c62 * zr + c71c72 * xr * zr);
  const g2 = g * g;

  const fgh = f * f + g2 + h * h;
  const fgh32 = Math.sqrt(fgh) ** 3;
  const fchsg2 = f * f + g2;

  // On the z axis the azimuth is undefined; -1 puts the point firmly outside.
  if (fchsg2 < 1e-5) return -1;

  const sqfchsg2 = Math.sqrt(fchsg2);
  const alpha = fchsg2 / fgh32;
  const theta = tnoon + 0.5 * dteta * (1 - f / sqfchsg2);
  return alpha - Math.sin(theta) ** 2;
}

/**
 * Smooth zero-to-one ramp in ksi, used to blend the region 2 representations
 * across their boundaries.
 *
 * @param {number} ksi The stretched coordinate.
 * @param {number} xks0 Centre of the ramp.
 * @param {number} dxksi Half-width of the ramp.
 * @returns {number} A value in [0, 1].
 */
function tksi(ksi, xks0, dxksi) {
  const tdz3 = 2 * dxksi ** 3;
  if (ksi - xks0 < -dxksi) return 0;
  if (ksi < xks0) {
    const br3 = (ksi - xks0 + dxksi) ** 3;
    return (1.5 * br3) / (tdz3 + br3);
  }
  if (ksi - xks0 < dxksi) {
    const br3 = (ksi - xks0 - dxksi) ** 3;
    return 1 + (1.5 * br3) / (tdz3 - br3);
  }
  return 1;
}

/**
 * Latitudinal profile used by the region 2 sheet for bx and by.
 *
 * @param {number} s Cosine of the colatitude.
 * @param {number} a Profile parameter; its sign selects the branch.
 * @returns {number} The profile value.
 */
function fexp(s, a) {
  if (a < 0) return Math.sqrt(-2 * a * Math.E) * s * Math.exp(a * s * s);
  return s * Math.exp(a * (s * s - 1));
}

/**
 * Latitudinal profile used by the region 2 sheet for bz.
 *
 * @param {number} s Cosine of the colatitude.
 * @param {number} a Profile parameter; its sign selects the branch.
 * @returns {number} The profile value.
 */
function fexp1(s, a) {
  if (a <= 0) return Math.exp(a * s * s);
  return Math.exp(a * (s * s - 1));
}

/**
 * Region 2 field far outside the sheet: three crossed loop pairs, an equatorial
 * nightside loop, and a four-loop system.
 *
 * @param {number} x SM x in Re.
 * @param {number} y SM y in Re.
 * @param {number} z SM z in Re.
 * @returns {number[]} [bx, by, bz], unnormalised.
 */
function r2outer(x, y, z) {
  const p = R2OUTER_PN;
  const contributions = [
    crosslp(x, y, z, p[0], p[1], p[2]),
    crosslp(x, y, z, p[3], p[4], p[5]),
    crosslp(x, y, z, p[6], p[7], p[8]),
    circle(x - p[9], y, z, p[10]),
    loops4(x, y, z, p[11], p[12], p[13], p[14], p[15], p[16]),
  ];

  const b = [0, 0, 0];
  for (let i = 0; i < contributions.length; i += 1) {
    for (let c = 0; c < 3; c += 1) b[c] += R2OUTER_PL[i] * contributions[i][c];
  }
  return b;
}

/**
 * Region 2 field inside the sheet.
 *
 * Five azimuthal harmonics, each a 5 x 4 x 4 product of a latitudinal profile,
 * an azimuthal harmonic and a ksi profile. The published routine spells all 240
 * products out as three enormous expressions; the index layout is regular, so
 * they are looped here.
 *
 * @param {number} x SM x in Re.
 * @param {number} y SM y in Re.
 * @param {number} z SM z in Re.
 * @returns {number[]} [bx, by, bz], unnormalised.
 */
function r2sheet(x, y, z) {
  const pnonx = R2SHEET_PNON.slice(0, 8);
  const pnony = R2SHEET_PNON.slice(8, 16);
  const pnonz = R2SHEET_PNON.slice(16, 24);

  // Variation across the current sheet, as three profiles in ksi.
  const xks = xksi(x, y, z);
  /**
   * The [1, t1, t2, t3] ksi profile for one component's parameters.
   *
   * @param {number[]} pnon That component's eight nonlinear parameters.
   * @returns {number[]} Four profile values, the first identically one.
   */
  const ksiProfile = (pnon) => [
    1,
    xks / Math.sqrt(xks * xks + pnon[5] ** 2),
    pnon[6] ** 3 / Math.sqrt(xks * xks + pnon[6] ** 2) ** 3,
    (xks / Math.sqrt(xks * xks + pnon[7] ** 2) ** 5) * 3.493856 * pnon[7] ** 4,
  ];

  const rho2 = x * x + y * y;
  const r = Math.sqrt(rho2 + z * z);
  const rho = Math.sqrt(rho2);

  const c1p = x / rho;
  const s1p = y / rho;
  const s2p = 2 * s1p * c1p;
  const c2p = c1p * c1p - s1p * s1p;
  const s3p = s2p * c1p + c2p * s1p;
  const c3p = c2p * c1p - s2p * s1p;
  const s4p = s3p * c1p + c3p * s1p;
  const ct = z / r;

  /**
   * Sum one component's 80 terms.
   *
   * @param {readonly number[]} coefficients The 80 fitted amplitudes.
   * @param {number[]} pnon That component's eight nonlinear parameters.
   * @param {number[]} azimuthal Four azimuthal factors.
   * @param {(s: number, a: number) => number} profile fexp or fexp1.
   * @returns {number} The component, unnormalised.
   */
  const component = (coefficients, pnon, azimuthal, profile) => {
    const t = ksiProfile(pnon);
    let total = 0;
    for (let j = 0; j < 5; j += 1) {
      let inner = 0;
      for (let m = 0; m < 4; m += 1) {
        let radial = 0;
        for (let n = 0; n < 4; n += 1) {
          radial += coefficients[j * 16 + m * 4 + n] * t[n];
        }
        inner += azimuthal[m] * radial;
      }
      total += profile(ct, pnon[j]) * inner;
    }
    return total;
  };

  return [
    component(R2SHEET_A, pnonx, [1, c1p, c2p, c3p], fexp),
    component(R2SHEET_B, pnony, [s1p, s2p, s3p, s4p], fexp),
    component(R2SHEET_C, pnonz, [1, c1p, c2p, c3p], fexp1),
  ];
}

/**
 * Conical harmonics, orders 1 through nmax, as separate field triples.
 *
 * @param {number} x SM x in Re.
 * @param {number} y SM y in Re.
 * @param {number} z SM z in Re.
 * @param {number} nmax Highest order.
 * @returns {number[][]} [cbx, cby, cbz], each nmax long.
 */
function bconic(x, y, z, nmax) {
  const cbx = new Array(nmax);
  const cby = new Array(nmax);
  const cbz = new Array(nmax);

  const ro2 = x * x + y * y;
  const ro = Math.sqrt(ro2);

  const cf = x / ro;
  const sf = y / ro;
  let cfm1 = 1;
  let sfm1 = 0;

  const r2 = ro2 + z * z;
  const r = Math.sqrt(r2);
  const c = z / r;
  const s = ro / r;
  const ch = Math.sqrt(0.5 * (1 + c));
  const sh = Math.sqrt(0.5 * (1 - c));
  let tnhm1 = 1;
  let cnhm1 = 1;
  const tnh = sh / ch;
  const cnh = 1 / tnh;

  for (let m = 0; m < nmax; m += 1) {
    const m1 = m + 1;
    const cfm = cfm1 * cf - sfm1 * sf;
    const sfm = cfm1 * sf + sfm1 * cf;
    cfm1 = cfm;
    sfm1 = sfm;
    const tnhm = tnhm1 * tnh;
    const cnhm = cnhm1 * cnh;
    const bt = ((m1 * cfm) / (r * s)) * (tnhm + cnhm);
    const bf =
      ((-0.5 * m1 * sfm) / r) * (tnhm1 / (ch * ch) - cnhm1 / (sh * sh));
    tnhm1 = tnhm;
    cnhm1 = cnhm;
    cbx[m] = bt * c * cf - bf * sf;
    cby[m] = bt * c * sf + bf * cf;
    cbz[m] = -bt * s;
  }

  return [cbx, cby, cbz];
}

/**
 * Field of a line of dipolar sources along the z axis.
 *
 * @param {number} x Offset in Re.
 * @param {number} y Offset in Re.
 * @param {number} z Offset in Re.
 * @param {number} mode 0 for a step in dipole strength across the equator,
 *   1 for a linear variation of the moment density.
 * @returns {number[]} [bx, by, bz], unnormalised.
 */
function dipdistr(x, y, z, mode) {
  const x2 = x * x;
  const rho2 = x2 + y * y;

  if (mode === 0) {
    const r2 = rho2 + z * z;
    const r3 = r2 * Math.sqrt(r2);
    return [
      ((z / rho2 ** 2) * (r2 * (y * y - x2) - rho2 * x2)) / r3,
      (((-x * y * z) / rho2 ** 2) * (2 * r2 + rho2)) / r3,
      x / r3,
    ];
  }

  return [
    (z / rho2 ** 2) * (y * y - x2),
    (-2 * x * y * z) / rho2 ** 2,
    x / rho2,
  ];
}

/**
 * Region 2 field close in: five conical harmonics, a four-loop system, and two
 * z-axis dipole distributions.
 *
 * @param {number} x SM x in Re.
 * @param {number} y SM y in Re.
 * @param {number} z SM z in Re.
 * @returns {number[]} [bx, by, bz], unnormalised.
 */
function r2inner(x, y, z) {
  const pl = R2INNER_PL;
  const pn = R2INNER_PN;

  const [cbx, cby, cbz] = bconic(x, y, z, 5);
  const db8 = loops4(x, y, z, pn[0], pn[1], pn[2], pn[3], pn[4], pn[5]);
  const db6 = dipdistr(x - pn[6], y, z, 0);
  const db7 = dipdistr(x - pn[7], y, z, 1);

  const conical = [cbx, cby, cbz];
  const b = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    for (let i = 0; i < 5; i += 1) b[c] += pl[i] * conical[c][i];
    b[c] += pl[5] * db6[c] + pl[6] * db7[c] + pl[7] * db8[c];
  }
  return b;
}

/**
 * Region 2 shielding field: eight cartesian harmonics, each with a flat and a
 * tilt-weighted amplitude.
 *
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @param {number} ps Dipole tilt in radians.
 * @returns {number[]} [hx, hy, hz] in nT.
 */
function birk2shl(x, y, z, ps) {
  const a = BIRK2_SHIELD;
  const p = a.slice(16, 18);
  const r = a.slice(18, 20);
  const q = a.slice(20, 22);
  const s = a.slice(22, 24);

  const cps = Math.cos(ps);
  const sps = Math.sin(ps);
  const s3ps = 4 * cps * cps - 1;

  let hx = 0;
  let hy = 0;
  let hz = 0;
  let l = 0;

  for (let m = 0; m < 2; m += 1) {
    for (let i = 0; i < 2; i += 1) {
      const cypi = Math.cos(y / p[i]);
      const cyqi = Math.cos(y / q[i]);
      const sypi = Math.sin(y / p[i]);
      const syqi = Math.sin(y / q[i]);
      for (let k = 0; k < 2; k += 1) {
        const szrk = Math.sin(z / r[k]);
        const czsk = Math.cos(z / s[k]);
        const czrk = Math.cos(z / r[k]);
        const szsk = Math.sin(z / s[k]);
        const sqpr = Math.sqrt(1 / p[i] ** 2 + 1 / r[k] ** 2);
        const sqqs = Math.sqrt(1 / q[i] ** 2 + 1 / s[k] ** 2);
        const epr = Math.exp(x * sqpr);
        const eqs = Math.exp(x * sqqs);
        let dx = 0;
        let dy = 0;
        let dz = 0;
        for (let n = 0; n < 2; n += 1) {
          if (m === 0) {
            if (n === 0) {
              dx = -sqpr * epr * cypi * szrk;
              dy = (epr / p[i]) * sypi * szrk;
              dz = (-epr / r[k]) * cypi * czrk;
            } else {
              dx *= cps;
              dy *= cps;
              dz *= cps;
            }
          } else if (n === 0) {
            dx = -sps * sqqs * eqs * cyqi * czsk;
            dy = ((sps * eqs) / q[i]) * syqi * czsk;
            dz = ((sps * eqs) / s[k]) * cyqi * szsk;
          } else {
            dx *= s3ps;
            dy *= s3ps;
            dz *= s3ps;
          }
          hx += a[l] * dx;
          hy += a[l] * dy;
          hz += a[l] * dz;
          l += 1;
        }
      }
    }
  }

  return [hx, hy, hz];
}

/**
 * Region 2 Birkeland current and partial ring current, unshielded.
 *
 * Three representations - outer, sheet and inner - are blended across two
 * transition bands in ksi. Every branch carries a factor of -0.02 so that
 * bz comes out as -1 nT at x = -5.3 Re on the sun-earth line.
 *
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @param {number} ps Dipole tilt in radians.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function r2Birk(x, y, z, ps) {
  const delarg = 0.03;
  const delarg1 = 0.015;
  const scale = -0.02;

  const cps = Math.cos(ps);
  const sps = Math.sin(ps);

  const xsm = x * cps - z * sps;
  const zsm = z * cps + x * sps;

  const xks = xksi(xsm, y, zsm);

  /**
   * Blend two representations with weights summing to the overall scale.
   *
   * @param {number[]} first The representation weighted by f1.
   * @param {number} f1 Its weight.
   * @param {number[]} second The representation weighted by the remainder.
   * @param {number} f2 Its weight.
   * @returns {number[]} [bxsm, by, bzsm].
   */
  const blend = (first, f1, second, f2) =>
    first.map((value, i) => value * f1 + second[i] * f2);

  let sm;
  if (xks < -(delarg + delarg1)) {
    sm = r2outer(xsm, y, zsm).map((value) => value * scale);
  } else if (xks < -delarg + delarg1) {
    const f2 = scale * tksi(xks, -delarg, delarg1);
    sm = blend(r2outer(xsm, y, zsm), scale - f2, r2sheet(xsm, y, zsm), f2);
  } else if (xks < delarg - delarg1) {
    sm = r2sheet(xsm, y, zsm).map((value) => value * scale);
  } else if (xks < delarg + delarg1) {
    const f1 = scale * tksi(xks, delarg, delarg1);
    sm = blend(r2inner(xsm, y, zsm), f1, r2sheet(xsm, y, zsm), scale - f1);
  } else {
    sm = r2inner(xsm, y, zsm).map((value) => value * scale);
  }

  const [bxsm, by, bzsm] = sm;
  return [bxsm * cps + bzsm * sps, by, bzsm * cps - bxsm * sps];
}

/**
 * Region 2 Birkeland system, shielded.
 *
 * @param {number} ps Dipole tilt in radians.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function birk2tot02(ps, x, y, z) {
  const [wx, wy, wz] = birk2shl(x, y, z, ps);
  const [hx, hy, hz] = r2Birk(x, y, z, ps);
  return [wx + hx, wy + hy, wz + hz];
}

/** Inclination of the region 1 octagonal double loops, in radians. */
const BIRK1_TILT = 1.00891;

/** Centres of the two region 1 loop systems along x, in Re. */
const BIRK1_LOOP_CENTRE = Object.freeze([2.28397, -5.60831]);

/** Radii of the two region 1 loop systems, in Re. */
const BIRK1_LOOP_RADIUS = Object.freeze([1.86106, 7.83281]);

/** Scale factors for the interior dipole grid along x and y. */
const BIRK1_DIPX = 1.12541;
const BIRK1_DIPY = 0.945719;

/** Offset and the two scalings of the plasma-sheet dipole grid. */
const BIRK1_DX = -0.16;
const BIRK1_SCALE_IN = 0.08;
const BIRK1_SCALE_OUT = 0.4;

/**
 * Local sheet tilt at radius r, shared by every region 1 source.
 *
 * Each interior dipole sits at its own radius and so sees its own tilt; this is
 * the same hinging law the tail uses, evaluated per source rather than per
 * field point.
 *
 * @param {number} sps Sine of the dipole tilt.
 * @param {number} r Radius in Re.
 * @returns {number[]} [sine, cosine] of the local tilt.
 */
function hingedTilt(sps, r) {
  const rh = HINGE_DISTANCE;
  const dr = HINGE_TRANSITION;
  const dr2 = dr * dr;
  const sqm = Math.sqrt((r - rh) ** 2 + dr2);
  const sqp = Math.sqrt((r + rh) ** 2 + dr2);
  const c = sqp - sqm;
  const q = Math.sqrt((rh + 1) ** 2 + dr2) - Math.sqrt((rh - 1) ** 2 + dr2);
  const spsas = ((sps / r) * c) / q;
  return [spsas, Math.sqrt(1 - spsas * spsas)];
}

/**
 * Region 1 high-latitude basis functions: the field of each unit source, so
 * that BIRK1_HIGH_LAT can weight them.
 *
 * Twelve dipoles inside the region 1 shell, each mirrored in y unless it sits on
 * the noon-midnight meridian, contributing a z-aligned and an x-aligned moment;
 * then two octagonal double loops.
 *
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @param {number} ps Dipole tilt in radians.
 * @returns {number[][]} A 3 x 26 table, indexed [component][source].
 */
function diploop1(x, y, z, ps) {
  const sps = Math.sin(ps);
  const d = [new Array(26), new Array(26), new Array(26)];

  for (let i = 0; i < 12; i += 1) {
    const dipoleX = BIRK1_XX1[i] * BIRK1_DIPX;
    const dipoleY = BIRK1_YY1[i] * BIRK1_DIPY;
    const r = Math.sqrt(dipoleX * dipoleX + dipoleY * dipoleY);
    const [spsas, cpsas] = hingedTilt(sps, r);
    const xd = dipoleX * cpsas;
    const yd = dipoleY;
    const zd = -dipoleX * spsas;

    const [bx1x, by1x, bz1x, , , , bx1z, by1z, bz1z] = dipxyz(
      x - xd,
      y - yd,
      z - zd,
    );
    // Dipoles on the noon-midnight meridian are their own mirror image, so the
    // second of the pair would double-count.
    let bx2x = 0;
    let by2x = 0;
    let bz2x = 0;
    let bx2z = 0;
    let by2z = 0;
    let bz2z = 0;
    if (Math.abs(yd) > 1e-10) {
      [bx2x, by2x, bz2x, , , , bx2z, by2z, bz2z] = dipxyz(
        x - xd,
        y + yd,
        z - zd,
      );
    }

    d[0][i] = bx1z + bx2z;
    d[1][i] = by1z + by2z;
    d[2][i] = bz1z + bz2z;
    d[0][i + 12] = (bx1x + bx2x) * sps;
    d[1][i + 12] = (by1x + by2x) * sps;
    d[2][i + 12] = (bz1x + bz2x) * sps;
  }

  const r1 = Math.abs(BIRK1_LOOP_CENTRE[0] + BIRK1_LOOP_RADIUS[0]);
  const [spsas1, cpsas1] = hingedTilt(sps, r1);
  const [bxoct1, byoct1, bzoct1] = crosslp(
    x * cpsas1 - z * spsas1,
    y,
    x * spsas1 + z * cpsas1,
    BIRK1_LOOP_CENTRE[0],
    BIRK1_LOOP_RADIUS[0],
    BIRK1_TILT,
  );
  d[0][24] = bxoct1 * cpsas1 + bzoct1 * spsas1;
  d[1][24] = byoct1;
  d[2][24] = -bxoct1 * spsas1 + bzoct1 * cpsas1;

  const r2 = Math.abs(BIRK1_LOOP_RADIUS[1] - BIRK1_LOOP_CENTRE[1]);
  const [spsas2, cpsas2] = hingedTilt(sps, r2);
  const [bx, by, bz] = circle(
    x * cpsas2 - z * spsas2 - BIRK1_LOOP_CENTRE[1],
    y,
    x * spsas2 + z * cpsas2,
    BIRK1_LOOP_RADIUS[1],
  );
  d[0][25] = bx * cpsas2 + bz * spsas2;
  d[1][25] = by;
  d[2][25] = -bx * spsas2 + bz * cpsas2;

  return d;
}

/**
 * Region 1 plasma-sheet basis functions.
 *
 * Five conical harmonics, then nine dipole sites each mirrored in both y and z
 * to give three moment orientations with two tilt weightings, then five z-axis
 * line sources with two orientations and two weightings.
 *
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @param {number} ps Dipole tilt in radians.
 * @returns {number[][]} A 3 x 79 table, indexed [component][source].
 */
function condip1(x, y, z, ps) {
  const sps = Math.sin(ps);
  const cps = Math.cos(ps);
  const d = [new Array(79), new Array(79), new Array(79)];

  const xsmShifted = x * cps - z * sps - BIRK1_DX;
  const zsm = z * cps + x * sps;
  const ro2 = xsmShifted * xsmShifted + y * y;
  const ro = Math.sqrt(ro2);

  const cf = new Array(5);
  const sf = new Array(5);
  cf[0] = xsmShifted / ro;
  sf[0] = y / ro;
  for (let m = 1; m < 5; m += 1) {
    cf[m] = cf[m - 1] * cf[0] - sf[m - 1] * sf[0];
    sf[m] = sf[m - 1] * cf[0] + cf[m - 1] * sf[0];
  }

  const r2 = ro2 + zsm * zsm;
  const r = Math.sqrt(r2);
  const c = zsm / r;
  const s = ro / r;
  const ch = Math.sqrt(0.5 * (1 + c));
  const sh = Math.sqrt(0.5 * (1 - c));
  const tnh = sh / ch;
  const cnh = 1 / tnh;

  for (let m = 0; m < 5; m += 1) {
    const m1 = m + 1;
    const bt = ((m1 * cf[m]) / (r * s)) * (tnh ** m1 + cnh ** m1);
    const bf =
      ((-0.5 * m1 * sf[m]) / r) * (tnh ** m / ch ** 2 - cnh ** m / sh ** 2);
    const bxsm = bt * c * cf[0] - bf * sf[0];
    const by = bt * c * sf[0] + bf * cf[0];
    const bzsm = -bt * s;

    d[0][m] = bxsm * cps + bzsm * sps;
    d[1][m] = by;
    d[2][m] = -bxsm * sps + bzsm * cps;
  }

  // The dipole grid uses the unshifted sheet coordinate.
  const xsm = x * cps - z * sps;

  for (let i = 0; i < 9; i += 1) {
    // Three of the nine sites sit inside the shell and take the inner scaling.
    const scale =
      i === 2 || i === 4 || i === 5 ? BIRK1_SCALE_IN : BIRK1_SCALE_OUT;
    const xd = BIRK1_XX2[i] * scale;
    const yd = BIRK1_YY2[i] * scale;
    const zd = BIRK1_ZZ2[i];

    const q1 = dipxyz(xsm - xd, y - yd, zsm - zd);
    const q2 = dipxyz(xsm - xd, y + yd, zsm - zd);
    const q3 = dipxyz(xsm - xd, y - yd, zsm + zd);
    const q4 = dipxyz(xsm - xd, y + yd, zsm + zd);

    /**
     * Combine one moment orientation across the four mirror images.
     *
     * @param {number} offset 0, 3 or 6 to select the x, y or z moment.
     * @param {number[]} signs The four image signs.
     * @returns {number[]} [bx, by, bz] of the combination.
     */
    const combine = (offset, signs) => [
      signs[0] * q1[offset] +
        signs[1] * q2[offset] +
        signs[2] * q3[offset] +
        signs[3] * q4[offset],
      signs[0] * q1[offset + 1] +
        signs[1] * q2[offset + 1] +
        signs[2] * q3[offset + 1] +
        signs[3] * q4[offset + 1],
      signs[0] * q1[offset + 2] +
        signs[1] * q2[offset + 2] +
        signs[2] * q3[offset + 2] +
        signs[3] * q4[offset + 2],
    ];

    /**
     * Rotate a sheet-frame triple into GSM and store it, optionally weighted by
     * the tilt.
     *
     * @param {number} column Column of the output table.
     * @param {number[]} b [bx, by, bz] in the sheet frame.
     * @param {number} weight 1 or sps.
     */
    const store = (column, b, weight) => {
      d[0][column] = weight * (b[0] * cps + b[2] * sps);
      d[1][column] = weight * b[1];
      d[2][column] = weight * (b[2] * cps - b[0] * sps);
    };

    const ix = i * 3 + 5;
    store(ix, combine(0, [1, 1, -1, -1]), 1);
    store(ix + 1, combine(3, [1, -1, -1, 1]), 1);
    store(ix + 2, combine(6, [1, 1, 1, 1]), 1);

    store(ix + 27, combine(0, [1, 1, 1, 1]), sps);
    store(ix + 28, combine(3, [1, -1, 1, -1]), sps);
    store(ix + 29, combine(6, [1, 1, -1, -1]), sps);
  }

  for (let i = 0; i < 5; i += 1) {
    const zd = BIRK1_ZZ2[i + 9];
    const q1 = dipxyz(xsm, y, zsm - zd);
    const q2 = dipxyz(xsm, y, zsm + zd);

    /**
     * Combine one moment orientation across the two image sources.
     *
     * @param {number} offset 0 or 6 to select the x or z moment.
     * @param {number} sign The sign of the second image.
     * @returns {number[]} [bx, by, bz] of the combination.
     */
    const combine = (offset, sign) => [
      q1[offset] + sign * q2[offset],
      q1[offset + 1] + sign * q2[offset + 1],
      q1[offset + 2] + sign * q2[offset + 2],
    ];

    const store = (column, b, weight) => {
      d[0][column] = weight * (b[0] * cps + b[2] * sps);
      d[1][column] = weight * b[1];
      d[2][column] = weight * (b[2] * cps - b[0] * sps);
    };

    const ix = 59 + i * 2;
    store(ix, combine(0, -1), 1);
    store(ix + 1, combine(6, 1), 1);
    store(ix + 10, combine(0, 1), sps);
    store(ix + 11, combine(6, -1), sps);
  }

  return d;
}

/**
 * Region 1 shielding field: 32 box harmonics, each with a flat and a
 * tilt-weighted amplitude.
 *
 * @param {number} ps Dipole tilt in radians.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function birk1shld(ps, x, y, z) {
  const a = BIRK1_SHIELD;
  const rp = a.slice(64, 68).map((value) => 1 / value);
  const rr = a.slice(68, 72).map((value) => 1 / value);
  const rq = a.slice(72, 76).map((value) => 1 / value);
  const rs = a.slice(76, 80).map((value) => 1 / value);

  const cps = Math.cos(ps);
  const sps = Math.sin(ps);
  const s3ps = 4 * cps * cps - 1;

  let bx = 0;
  let by = 0;
  let bz = 0;
  let l = 0;

  for (let m = 0; m < 2; m += 1) {
    for (let i = 0; i < 4; i += 1) {
      const cypi = Math.cos(y * rp[i]);
      const cyqi = Math.cos(y * rq[i]);
      const sypi = Math.sin(y * rp[i]);
      const syqi = Math.sin(y * rq[i]);
      for (let k = 0; k < 4; k += 1) {
        const szrk = Math.sin(z * rr[k]);
        const czsk = Math.cos(z * rs[k]);
        const czrk = Math.cos(z * rr[k]);
        const szsk = Math.sin(z * rs[k]);
        const sqpr = Math.sqrt(rp[i] ** 2 + rr[k] ** 2);
        const sqqs = Math.sqrt(rq[i] ** 2 + rs[k] ** 2);
        const epr = Math.exp(x * sqpr);
        const eqs = Math.exp(x * sqqs);
        let hx = 0;
        let hy = 0;
        let hz = 0;
        for (let n = 0; n < 2; n += 1) {
          if (m === 0) {
            if (n === 0) {
              hx = -sqpr * epr * cypi * szrk;
              hy = rp[i] * epr * sypi * szrk;
              hz = -rr[k] * epr * cypi * czrk;
            } else {
              hx *= cps;
              hy *= cps;
              hz *= cps;
            }
          } else if (n === 0) {
            hx = -sps * sqqs * eqs * cyqi * czsk;
            hy = sps * rq[i] * eqs * syqi * czsk;
            hz = sps * rs[k] * eqs * cyqi * szsk;
          } else {
            hx *= s3ps;
            hy *= s3ps;
            hz *= s3ps;
          }
          bx += a[l] * hx;
          by += a[l] * hy;
          bz += a[l] * hz;
          l += 1;
        }
      }
    }
  }

  return [bx, by, bz];
}

/**
 * Weight a basis table by its amplitudes.
 *
 * @param {readonly number[]} amplitudes One per column.
 * @param {number[][]} basis A 3 x n table from diploop1 or condip1.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function weighted(amplitudes, basis) {
  const b = [0, 0, 0];
  for (let i = 0; i < amplitudes.length; i += 1) {
    for (let c = 0; c < 3; c += 1) b[c] += amplitudes[i] * basis[c][i];
  }
  return b;
}

/**
 * Latitudinal half-thickness of the region 1 oval, in radians: the band over
 * which the high-latitude and plasma-sheet representations are blended.
 */
const BIRK1_OVAL_HALF_WIDTH = 0.034906;

/**
 * Region 1 field, from the potential mapped onto sphero-dipolar coordinates.
 *
 * The inner and outer regions get separate representations, and between them
 * lies the region 1 oval. A point falls into one of four zones - high latitude,
 * plasma sheet, or one of the two boundary layers - and in a boundary layer the
 * field is interpolated between the two representations evaluated at the edges
 * of the band.
 *
 * This is the second version of the model: the outer region uses circular
 * current loops rather than octagonal ones, which is faster.
 *
 * @param {number} ps Dipole tilt in radians.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {number[]} [bx, by, bz] in nT.
 */
function birk1tot02(ps, x, y, z) {
  const highLat = (px, py, pz) =>
    weighted(BIRK1_HIGH_LAT, diploop1(px, py, pz, ps));
  const sheet = (px, py, pz) => weighted(BIRK1_SHEET, condip1(px, py, pz, ps));

  // Latitudes of the region 1 oval at noon and midnight, in degrees.
  const xltday = 78;
  const xltnght = 70;
  const degrees = 0.01745329;
  const dtet0 = BIRK1_OVAL_HALF_WIDTH;

  // The northern and southern ovals are assumed symmetric in SM coordinates.
  const tnoonn = (90 - xltday) * degrees;
  const tnoons = Math.PI - tnoonn;
  const dtetdn = (xltday - xltnght) * degrees;

  const sps = Math.sin(ps);
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  const r3 = r * r2;

  const [spsas, cpsas] = hingedTilt(sps, r);
  const xas = x * cpsas - z * spsas;
  const zas = x * spsas + z * cpsas;
  const pas = xas !== 0 || y !== 0 ? Math.atan2(y, xas) : 0;
  const tas = Math.atan2(Math.sqrt(xas * xas + y * y), zas);
  const stas = Math.sin(tas);
  const f = stas / (stas ** 6 * (1 - r3) + r3) ** 0.1666666667;

  // Colatitude of the footpoint of the field line through this point.
  let tet0 = Math.asin(f);
  if (tas > 1.5707963) tet0 = Math.PI - tet0;
  const dtet = dtetdn * Math.sin(pas * 0.5) ** 2;
  const tetr1n = tnoonn + dtet;
  const tetr1s = tnoons - dtet;

  /**
   * Field interpolated across one boundary layer of the oval.
   *
   * @param {number} tetr1 Centre colatitude of that oval, in radians.
   * @param {number} hemisphere +1 for the northern oval, -1 for the southern.
   * @param {(px: number, py: number, pz: number) => number[]} inner The
   *   representation valid on the low-colatitude edge.
   * @param {(px: number, py: number, pz: number) => number[]} outer The
   *   representation valid on the high-colatitude edge.
   * @returns {number[]} [bx, by, bz] in nT.
   */
  const acrossBoundary = (tetr1, hemisphere, inner, outer) => {
    const sqr = Math.sqrt(r);
    /**
     * A point on one edge of the band, at this radius and azimuth.
     *
     * @param {number} tet Colatitude of the edge, in radians.
     * @returns {number[]} [x, y, z] in GSM, in Re.
     */
    const edge = (tet) => {
      const stas1 = sqr / (r3 + 1 / Math.sin(tet) ** 6 - 1) ** 0.1666666667;
      const ctas1 = hemisphere * Math.sqrt(1 - stas1 * stas1);
      const xas1 = r * stas1 * Math.cos(pas);
      const yEdge = r * stas1 * Math.sin(pas);
      const zas1 = r * ctas1;
      return [xas1 * cpsas + zas1 * spsas, yEdge, -xas1 * spsas + zas1 * cpsas];
    };

    const [x1, y1, z1] = edge(tetr1 - dtet0);
    const [x2, y2, z2] = edge(tetr1 + dtet0);
    const b1 = inner(x1, y1, z1);
    const b2 = outer(x2, y2, z2);

    const ss = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2 + (z2 - z1) ** 2);
    const ds = Math.sqrt((x - x1) ** 2 + (y - y1) ** 2 + (z - z1) ** 2);
    const frac = ds / ss;
    return b1.map((value, i) => value * (1 - frac) + b2[i] * frac);
  };

  let b;
  if (tet0 < tetr1n - dtet0 || tet0 > tetr1s + dtet0) {
    // High latitude, in either hemisphere.
    b = highLat(x, y, z);
  } else if (tet0 > tetr1n + dtet0 && tet0 < tetr1s - dtet0) {
    // Plasma sheet.
    b = sheet(x, y, z);
  } else if (tet0 >= tetr1n - dtet0 && tet0 <= tetr1n + dtet0) {
    // Northern plasma sheet boundary layer: high latitude above, sheet below.
    b = acrossBoundary(tetr1n, 1, highLat, sheet);
  } else {
    // Southern boundary layer, where the two representations swap ends.
    b = acrossBoundary(tetr1s, -1, sheet, highLat);
  }

  const [bsx, bsy, bsz] = birk1shld(ps, x, y, z);
  return [b[0] + bsx, b[1] + bsy, b[2] + bsz];
}

/**
 * Potential interconnection field inside the magnetosphere.
 *
 * This is the part of the IMF that threads the boundary, and it is what lets
 * southward IMF erode the dayside. Given in the frame rotated by the IMF clock
 * angle, so z lies along the IMF Bz, and normalised to an IMF Bt of 1 nT.
 *
 * @param {number} x Rotated-frame x in Re.
 * @param {number} y Rotated-frame y in Re.
 * @param {number} z Rotated-frame z in Re.
 * @returns {number[]} [bx, by, bz] per nT of IMF Bt.
 */
function intercon(x, y, z) {
  const a = INTERCON;
  const rp = a.slice(9, 12).map((value) => 1 / value);
  const rr = a.slice(12, 15).map((value) => 1 / value);

  let bx = 0;
  let by = 0;
  let bz = 0;
  let l = 0;

  // Perpendicular symmetry only.
  for (let i = 0; i < 3; i += 1) {
    const cypi = Math.cos(y * rp[i]);
    const sypi = Math.sin(y * rp[i]);
    for (let k = 0; k < 3; k += 1) {
      const szrk = Math.sin(z * rr[k]);
      const czrk = Math.cos(z * rr[k]);
      const sqpr = Math.sqrt(rp[i] ** 2 + rr[k] ** 2);
      const epr = Math.exp(x * sqpr);

      bx += a[l] * (-sqpr * epr * cypi * szrk);
      by += a[l] * (rp[i] * epr * sypi * szrk);
      bz += a[l] * (-rr[k] * epr * cypi * czrk);
      l += 1;
    }
  }

  return [bx, by, bz];
}

/** Reference dynamic pressure the model was normalised at, in nPa. */
const PDYN_REFERENCE = 2;

/** Reference epsilon (the coupling function) the model was normalised at. */
const EPSILON_REFERENCE = 3630.7;

/**
 * Magnetopause shape parameters: the semi-latus rectum, the eccentricity-like
 * ratio, the nose distance, and the half-width of the boundary layer, all at
 * the reference pressure.
 */
const MAGNETOPAUSE_AM0 = 70;
const MAGNETOPAUSE_S0 = 1.08;
const MAGNETOPAUSE_X00 = 5.48;
const MAGNETOPAUSE_DSIG = 0.005;

/** Decay scales of the interconnection field's penetration, in Re. */
const IMF_DECAY_X = 20;
const IMF_DECAY_Y = 10;

/**
 * @typedef {object} T96Input
 * @property {number} pdyn Solar wind dynamic pressure in nPa.
 * @property {number} dst Dst index in nT.
 * @property {number} byimf IMF By in GSM, in nT.
 * @property {number} bzimf IMF Bz in GSM, in nT.
 */

/**
 * Tsyganenko T96 external field.
 *
 * Returns the field of the magnetospheric current systems only - the internal
 * field is IGRF's job, and the caller adds the two.
 *
 * Three cases, decided by where the point falls relative to the model
 * magnetopause. Inside, the answer is the sum of the shielded current systems
 * plus the penetrated interconnection field. Outside, the magnetosphere is not
 * there at all: the answer is the interconnection field minus the geodipole, so
 * that adding IGRF back leaves only the draped IMF. In the thin layer between,
 * the two are interpolated, with the dipole added and removed so the
 * interpolation acts on the total field rather than on the external part alone.
 *
 * @param {T96Input} input Upstream solar wind and ground disturbance.
 * @param {number} ps Dipole tilt in radians.
 * @param {number} x GSM x in Re.
 * @param {number} y GSM y in Re.
 * @param {number} z GSM z in Re.
 * @returns {{x: number, y: number, z: number}} External field in nT, GSM.
 */
export function t96(input, ps, x, y, z) {
  const { pdyn, dst, byimf, bzimf } = input;
  const a = T96_A;

  const sps = Math.sin(ps);
  // Estimated total near-earth depression. Usually negative.
  const depr = 0.8 * dst - 13 * Math.sqrt(pdyn);

  const bt = Math.sqrt(byimf * byimf + bzimf * bzimf);
  let theta = 0;
  if (byimf !== 0 || bzimf !== 0) {
    theta = Math.atan2(byimf, bzimf);
    if (theta < 0) theta += 2 * Math.PI;
  }
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const eps = 718.5 * Math.sqrt(pdyn) * bt * Math.sin(theta / 2);

  const facteps = eps / EPSILON_REFERENCE - 1;
  const factpd = Math.sqrt(pdyn / PDYN_REFERENCE) - 1;

  // Amplitude of the ring current: positive, and equal to the magnitude of the
  // depression it produces at the origin.
  const rcampl = -a[0] * depr;
  const tampl2 = a[1] + a[2] * factpd + a[3] * facteps;
  const tampl3 = a[4] + a[5] * factpd;
  const b1ampl = a[6] + a[7] * facteps;
  // Region 2 carries 40% of the region 1 current; the factor of 20 absorbs the
  // difference in how the two systems are normalised.
  const b2ampl = 20 * b1ampl;
  const reconn = a[8];

  // Pressure scaling: higher pressure shrinks the whole magnetosphere, which the
  // model represents by evaluating at a scaled position.
  const xappa = (pdyn / PDYN_REFERENCE) ** 0.14;
  const xappa3 = xappa ** 3;

  // Rotated into the frame where z lies along the IMF Bz.
  const ys = y * ct - z * st;
  const zs = z * ct + y * st;

  const factimf = Math.exp(x / IMF_DECAY_X - (ys / IMF_DECAY_Y) ** 2);
  const oimfx = 0;
  const oimfy = reconn * byimf * factimf;
  const oimfz = reconn * bzimf * factimf;
  const rimfampl = reconn * bt;

  const xx = x * xappa;
  const yy = y * xappa;
  const zz = z * xappa;

  // Where the point sits relative to the magnetopause, as the sigma coordinate
  // of the scaled surface. Sigma = s0 is the boundary itself.
  const x0 = MAGNETOPAUSE_X00 / xappa;
  const am = MAGNETOPAUSE_AM0 / xappa;
  const rho2 = y * y + z * z;
  const asq = am * am;
  // Tailward of x0 - am the boundary becomes a cylinder, so the shift is pinned.
  const xmxm = Math.max(am + x - x0, 0);
  const axx0 = xmxm * xmxm;
  const aro = asq + rho2;
  const sigma = Math.sqrt(
    (aro + axx0 + Math.sqrt((aro + axx0) ** 2 - 4 * asq * axx0)) / (2 * asq),
  );

  if (sigma >= MAGNETOPAUSE_S0 + MAGNETOPAUSE_DSIG) {
    // Outside the magnetosphere and its boundary layer.
    const [qx, qy, qz] = dipole(ps, x, y, z);
    return { x: oimfx - qx, y: oimfy - qy, z: oimfz - qz };
  }

  const [cfx, cfy, cfz] = dipshld(ps, xx, yy, zz);
  const { ringCurrent, tailDisk, tailSheet } = tailrc96(sps, xx, yy, zz);
  const [r1x, r1y, r1z] = birk1tot02(ps, xx, yy, zz);
  const [r2x, r2y, r2z] = birk2tot02(ps, xx, yy, zz);
  const [rimfx, rimfys, rimfzs] = intercon(xx, ys * xappa, zs * xappa);
  // Back out of the IMF-aligned frame.
  const rimfy = rimfys * ct + rimfzs * st;
  const rimfz = rimfzs * ct - rimfys * st;

  const fx =
    cfx * xappa3 +
    rcampl * ringCurrent[0] +
    tampl2 * tailDisk[0] +
    tampl3 * tailSheet[0] +
    b1ampl * r1x +
    b2ampl * r2x +
    rimfampl * rimfx;
  const fy =
    cfy * xappa3 +
    rcampl * ringCurrent[1] +
    tampl2 * tailDisk[1] +
    tampl3 * tailSheet[1] +
    b1ampl * r1y +
    b2ampl * r2y +
    rimfampl * rimfy;
  const fz =
    cfz * xappa3 +
    rcampl * ringCurrent[2] +
    tampl2 * tailDisk[2] +
    tampl3 * tailSheet[2] +
    b1ampl * r1z +
    b2ampl * r2z +
    rimfampl * rimfz;

  if (sigma < MAGNETOPAUSE_S0 - MAGNETOPAUSE_DSIG) {
    // Comfortably inside.
    return { x: fx, y: fy, z: fz };
  }

  // In the boundary layer, blend the two. The dipole goes in and comes back out
  // because the interpolation is only well behaved on the total field.
  const fint = 0.5 * (1 - (sigma - MAGNETOPAUSE_S0) / MAGNETOPAUSE_DSIG);
  const fext = 0.5 * (1 + (sigma - MAGNETOPAUSE_S0) / MAGNETOPAUSE_DSIG);
  const [qx, qy, qz] = dipole(ps, x, y, z);
  return {
    x: (fx + qx) * fint + oimfx * fext - qx,
    y: (fy + qy) * fint + oimfy * fext - qy,
    z: (fz + qz) * fint + oimfz * fext - qz,
  };
}
