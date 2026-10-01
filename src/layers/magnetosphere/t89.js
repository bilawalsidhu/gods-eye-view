/**
 * Tsyganenko T89c external magnetospheric field.
 *
 * The field produced by magnetospheric current systems - tail current, ring
 * current, Chapman-Ferraro and Birkeland currents - which IGRF does not
 * contain. Past a few Earth radii these dominate, and without them field lines
 * balloon out on the dayside and never form a tail.
 *
 * Ported from the MIT-licensed Python `geopack` translation of Tsyganenko's
 * Fortran, which is itself goto-free. The body is straight-line scalar
 * arithmetic with a single conditional, so this is a transliteration rather
 * than a reimplementation, and it is validated against the Python original
 * point by point. An empirical field that is subtly wrong still looks like a
 * magnetosphere, so agreeing with ourselves would prove nothing.
 *
 * This is T89c, the 1992 revision: it carries the two extra terms giving the
 * tail current a dipole-tilt dependence (a[15], a[16]).
 *
 * Inputs are GSM coordinates in Earth radii and the dipole tilt in radians;
 * output is nT in GSM.
 *
 * Reference: Tsyganenko, N. A. (1989), "A magnetospheric magnetic field model
 * with a warped tail current sheet", Planet. Space Sci., 37, 5-20.
 *
 * @module layers/magnetosphere/t89
 */

/**
 * Model coefficients, one row per ground-disturbance band.
 *
 * Band 1 is Kp 0/0+, rising to band 7 for Kp >= 6-. The published table is
 * column-major; it is stored row-per-band here so a band is one contiguous
 * lookup rather than a stride.
 */
export const T89_COEFFICIENTS = Object.freeze(
  [
    // Kp band 1
    [
      -116.53, -10719, 42.375, 59.753, -11363, 1.7844, 30.268, -0.35372e-1,
      -0.66832e-1, 0.16456e-1, -1.3024, 0.16529e-2, 0.20293e-2, 20.289,
      -0.25203e-1, 224.91, -9234.8, 22.788, 7.8813, 1.8362, -0.27228, 8.8184,
      2.8714, 14.468, 32.177, 0.01, 0.0, 7.0459, 4.0, 20.0,
    ],
    // Kp band 2
    [
      -55.553, -13198, 60.647, 61.072, -16064, 2.2534, 34.407, -0.38887e-1,
      -0.94571e-1, 0.27154e-1, -1.3901, 0.1346e-2, 0.13238e-2, 23.005,
      -0.30565e-1, 55.047, -3875.7, 20.178, 7.9693, 1.4575, 0.89471, 9.4039,
      3.5215, 14.474, 36.555, 0.01, 0.0, 7.0787, 4.0, 20.0,
    ],
    // Kp band 3
    [
      -101.34, -13480, 111.35, 12.386, -24699, 2.6459, 38.948, -0.3408e-1,
      -0.12404, 0.29702e-1, -1.4052, 0.12103e-2, 0.16381e-2, 24.49, -0.37705e-1,
      -298.32, 4400.9, 18.692, 7.9064, 1.3047, 2.4541, 9.7012, 7.1624, 14.288,
      33.822, 0.01, 0.0, 6.7442, 4.0, 20.0,
    ],
    // Kp band 4
    [
      -181.69, -12320, 173.79, -96.664, -39051, 3.2633, 44.968, -0.46377e-1,
      -0.16686, 0.048298, -1.5473, 0.10277e-2, 0.31632e-2, 27.341, -0.50655e-1,
      -514.1, 12482, 16.257, 8.5834, 1.0194, 3.6148, 8.6042, 5.5057, 13.778,
      32.373, 0.01, 0.0, 7.3195, 4.0, 20.0,
    ],
    // Kp band 5
    [
      -436.54, -9001.0, 323.66, -410.08, -50340, 3.9932, 58.524, -0.38519e-1,
      -0.26822, 0.74528e-1, -1.4268, -0.10985e-2, 0.96613e-2, 27.557,
      -0.56522e-1, -867.03, 20652, 14.101, 8.3501, 0.72996, 3.8149, 9.2908,
      6.4674, 13.729, 28.353, 0.01, 0.0, 7.4237, 4.0, 20.0,
    ],
    // Kp band 6
    [
      -707.77, -4471.9, 432.81, -435.51, -60400, 4.6229, 68.178, -0.88245e-1,
      -0.21002, 0.11846, -2.6711, 0.22305e-2, 0.1091e-1, 27.547, -0.5408e-1,
      -424.23, 1100.2, 13.954, 7.5337, 0.89714, 3.7813, 8.2945, 5.174, 14.213,
      25.237, 0.01, 0.0, 7.0037, 4.0, 20.0,
    ],
    // Kp band 7
    [
      -1190.4, 2749.9, 742.56, -1110.3, -77193, 7.6727, 102.05, -0.96015e-1,
      -0.74507, 0.11214, -1.3614, 0.15157e-2, 0.22283e-1, 23.164, -0.74146e-1,
      -2219.1, 48253, 12.714, 7.6777, 0.57138, 2.9633, 9.3909, 9.7263, 11.123,
      21.558, 0.01, 0.0, 4.4518, 4.0, 20.0,
    ],
  ].map((row) => Object.freeze(row)),
);

/** Kp index to the model's 1..7 disturbance band. */
export function t89BandForKp(kp) {
  if (!Number.isFinite(kp) || kp < 1) return 1;
  if (kp >= 6) return 7;
  return Math.floor(kp) + 1;
}

/**
 * External field in GSM nT.
 *
 * @param {number} band 1..7 disturbance band, from `t89BandForKp`.
 * @param {number} ps Dipole tilt angle, radians.
 * @param {number} x GSM x in Earth radii, sunward.
 * @param {number} y GSM y in Earth radii.
 * @param {number} z GSM z in Earth radii.
 * @returns {{x:number,y:number,z:number}} nT, GSM.
 */
export function t89(band, ps, x, y, z) {
  const index = Math.min(7, Math.max(1, Math.round(band))) - 1;
  const a = T89_COEFFICIENTS[index];
  const xi = [x, y, z, ps];
  const der = [
    new Float64Array(30),
    new Float64Array(30),
    new Float64Array(30),
  ];
  let a02,
    a6h,
    a9t,
    adr,
    adrt,
    adrt2,
    adsl,
    ak1,
    ak10,
    ak11,
    ak12,
    ak13,
    ak14,
    ak15,
    ak16,
    ak17,
    ak2,
    ak3,
    ak4,
    ak5,
    ak6,
    ak610,
    ak7,
    ak711,
    ak8,
    ak812,
    ak9,
    ak913,
    at,
    att,
    brrz1,
    brrz2,
    bxcl,
    bxt,
    bycl,
    byt,
    bzcl,
    bzt,
    cps,
    d,
    d0,
    d2,
    d2zsgy,
    dbldel,
    dbxc1,
    dbxc2,
    dbxdp,
    dbzc1,
    dbzc2,
    dbzdp,
    dd,
    ddr,
    ddy,
    delt,
    dely2,
    dfa0,
    drdyc2,
    drdyc3,
    dsfc,
    dsqt,
    dt,
    dvx,
    dwcx,
    dwcy,
    dwx,
    dx,
    dxl,
    dyc,
    dyc2,
    dzsx,
    dzsy,
    ec,
    ecz,
    ecz2,
    es,
    esy,
    esz,
    eszy2,
    eszz2,
    ex,
    f1,
    f3,
    f5,
    f7,
    f9,
    fa0,
    facxy,
    faq,
    fc,
    fk,
    fs,
    fx,
    fxmn,
    fxpl,
    fxym,
    fxyp,
    fy,
    fyc,
    fydy,
    fymn,
    fypl,
    fypr,
    fz,
    fzmn,
    fzpl,
    g,
    gam,
    gamh,
    gsp,
    gsy4,
    h,
    ha02,
    hlwc2m,
    hrdxl,
    hs,
    htp,
    hxld2m,
    hxlw2m,
    om,
    oms,
    omsv,
    p,
    q,
    rc,
    rdsq,
    rdsq2,
    rdx2,
    rdx2m,
    rdxl,
    rdy,
    rdy2,
    rdyc2,
    ro2,
    rogsm2,
    rpi,
    rqc,
    rqc2,
    rqd,
    rqds,
    rt,
    rtr,
    rtt,
    s1,
    smn,
    spl,
    sps,
    sx,
    sx1,
    sxa,
    sxc,
    sxrc,
    sy1,
    sy4,
    sya,
    sz1,
    sza,
    szrm,
    szrp,
    t,
    tilt,
    tlt2,
    tps,
    tr,
    v,
    w,
    w1,
    w2,
    w3,
    w4,
    w5,
    w6,
    wc,
    wcsm,
    wcsp,
    wt,
    wtfs,
    x2,
    xd,
    xdwx,
    xghs,
    xld2,
    xlw2,
    xlwc2,
    xrc,
    xrc16,
    xsm,
    xsm2,
    xsmx,
    xsxc,
    xxd,
    xywc,
    xzr,
    xzyz,
    y2,
    y4,
    y410,
    ydwy,
    yfy1,
    yn,
    ynd,
    ynp,
    yzr,
    z2,
    zmn,
    zpl,
    zr,
    zs,
    zs1,
    zsm;
  // The last four quantities define variation of tail sheet thickness along X
  [a02, xlw2, yn, rpi, rt] = [25, 170, 30.0, 0.31830989, 30];
  [xd, xld2] = [0, 40];
  // The two quantities belong to the function WC which confines tail closure current in X- and Y- direction
  [sxc, xlwc2] = [4, 50];
  dxl = 20;
  dyc = a[29];
  dyc2 = dyc ** 2;
  dx = a[17];
  ha02 = 0.5 * a02;
  rdx2m = -1 / dx ** 2;
  rdx2 = -rdx2m;
  rdyc2 = 1 / dyc2;
  hlwc2m = -0.5 * xlwc2;
  drdyc2 = -2 * rdyc2;
  drdyc3 = 2 * rdyc2 * Math.sqrt(rdyc2);
  hxlw2m = -0.5 * xlw2;
  adr = a[18];
  d0 = a[19];
  dd = a[20];
  rc = a[21];
  g = a[22];
  at = a[23];
  dt = d0;
  p = a[24];
  delt = a[25];
  q = a[26];
  sx = a[27];
  gam = a[28];
  hxld2m = -0.5 * xld2;
  [adsl, xghs, h, hs, gamh] = [0, 0, 0, 0, 0];
  dbldel = 2 * delt;
  w1 = -0.5 / dx;
  w2 = w1 * 2;
  w4 = -1 / 3;
  w3 = w4 / dx;
  w5 = -0.5;
  w6 = -3;
  [
    ak1,
    ak2,
    ak3,
    ak4,
    ak5,
    ak6,
    ak7,
    ak8,
    ak9,
    ak10,
    ak11,
    ak12,
    ak13,
    ak14,
    ak15,
    ak16,
    ak17,
  ] = a.slice(0, 17);
  [sxa, sya, sza] = [0, 0, 0];
  ak610 = ak6 * w1 + ak10 * w5;
  ak711 = ak7 * w2 - ak11;
  ak812 = ak8 * w2 + ak12 * w6;
  ak913 = ak9 * w3 + ak13 * w4;
  rdxl = 1 / dxl;
  hrdxl = 0.5 * rdxl;
  a6h = ak6 * 0.5;
  a9t = ak9 / 3;
  ynp = (rpi / yn) * 0.5;
  ynd = 2 * yn;
  [x, y, z, tilt] = xi.slice(0, 4);
  tlt2 = tilt ** 2;
  sps = Math.sin(tilt);
  cps = Math.cos(tilt);
  x2 = x * x;
  y2 = y * y;
  z2 = z * z;
  tps = sps / cps;
  htp = tps * 0.5;
  gsp = g * sps;
  xsm = x * cps - z * sps;
  zsm = x * sps + z * cps;
  // calculate the function zs defining the shape of the tail current sheet and its spatial derivatives:
  xrc = xsm + rc;
  xrc16 = xrc ** 2 + 16;
  sxrc = Math.sqrt(xrc16);
  y4 = y2 * y2;
  y410 = y4 + 1e4;
  sy4 = sps / y410;
  gsy4 = g * sy4;
  zs1 = htp * (xrc - sxrc);
  dzsx = -zs1 / sxrc;
  zs = zs1 - gsy4 * y4;
  d2zsgy = (-sy4 / y410) * 4e4 * y2 * y;
  dzsy = g * d2zsgy;
  // calculate the components of the ring current contribution:
  xsm2 = xsm ** 2;
  dsqt = Math.sqrt(xsm2 + a02);
  fa0 = 0.5 * (1 + xsm / dsqt);
  ddr = d0 + dd * fa0;
  dfa0 = ha02 / dsqt ** 3;
  zr = zsm - zs;
  tr = Math.sqrt(zr ** 2 + ddr ** 2);
  rtr = 1 / tr;
  ro2 = xsm2 + y2;
  adrt = adr + tr;
  adrt2 = adrt ** 2;
  fk = 1 / (adrt2 + ro2);
  dsfc = Math.sqrt(fk);
  fc = fk ** 2 * dsfc;
  facxy = 3 * adrt * fc * rtr;
  xzr = xsm * zr;
  yzr = y * zr;
  dbxdp = facxy * xzr;
  der[1][4] = facxy * yzr;
  xzyz = xsm * dzsx + y * dzsy;
  faq = zr * xzyz - ddr * dd * dfa0 * xsm;
  dbzdp = fc * (2 * adrt2 - ro2) + facxy * faq;
  der[0][4] = dbxdp * cps + dbzdp * sps;
  der[2][4] = dbzdp * cps - dbxdp * sps;
  // calculate the tail current sheet contribution:
  dely2 = delt * y2;
  d = dt + dely2;
  if (Math.abs(gam) >= 1e-6) {
    xxd = xsm - xd;
    rqd = 1 / (xxd ** 2 + xld2);
    rqds = Math.sqrt(rqd);
    h = 0.5 * (1 + xxd * rqds);
    hs = -hxld2m * rqd * rqds;
    gamh = gam * h;
    d = d + gamh;
    xghs = xsm * gam * hs;
    adsl = -d * xghs;
  }
  d2 = d ** 2;
  t = Math.sqrt(zr ** 2 + d2);
  xsmx = xsm - sx;
  rdsq2 = 1 / (xsmx ** 2 + xlw2);
  rdsq = Math.sqrt(rdsq2);
  v = 0.5 * (1 - xsmx * rdsq);
  dvx = hxlw2m * rdsq * rdsq2;
  om = Math.sqrt(Math.sqrt(xsm2 + 16) - xsm);
  oms = (-om / (om * om + xsm)) * 0.5;
  rdy = 1 / (p + q * om);
  omsv = oms * v;
  rdy2 = rdy ** 2;
  fy = 1 / (1 + y2 * rdy2);
  w = v * fy;
  yfy1 = 2 * fy * y2 * rdy2;
  fypr = yfy1 * rdy;
  fydy = fypr * fy;
  dwx = dvx * fy + fydy * q * omsv;
  ydwy = -v * yfy1 * fy;
  ddy = dbldel * y;
  att = at + t;
  s1 = Math.sqrt(att ** 2 + ro2);
  f5 = 1 / s1;
  f7 = 1 / (s1 + att);
  f1 = f5 * f7;
  f3 = f5 ** 3;
  f9 = att * f3;
  fs = zr * xzyz - d * y * ddy + adsl;
  xdwx = xsm * dwx + ydwy;
  rtt = 1 / t;
  wt = w * rtt;
  brrz1 = wt * f1;
  brrz2 = wt * f3;
  dbxc1 = brrz1 * xzr;
  dbxc2 = brrz2 * xzr;
  der[1][0] = brrz1 * yzr;
  der[1][1] = brrz2 * yzr;
  der[1][15] = der[1][0] * tlt2;
  der[1][16] = der[1][1] * tlt2;
  wtfs = wt * fs;
  dbzc1 = w * f5 + xdwx * f7 + wtfs * f1;
  dbzc2 = w * f9 + xdwx * f1 + wtfs * f3;
  der[0][0] = dbxc1 * cps + dbzc1 * sps;
  der[0][1] = dbxc2 * cps + dbzc2 * sps;
  der[2][0] = dbzc1 * cps - dbxc1 * sps;
  der[2][1] = dbzc2 * cps - dbxc2 * sps;
  der[0][15] = der[0][0] * tlt2;
  der[0][16] = der[0][1] * tlt2;
  der[2][15] = der[2][0] * tlt2;
  der[2][16] = der[2][1] * tlt2;
  // calculate contribution from the closure currents
  zpl = z + rt;
  zmn = z - rt;
  rogsm2 = x2 + y2;
  spl = Math.sqrt(zpl ** 2 + rogsm2);
  smn = Math.sqrt(zmn ** 2 + rogsm2);
  xsxc = x - sxc;
  rqc2 = 1 / (xsxc ** 2 + xlwc2);
  rqc = Math.sqrt(rqc2);
  fyc = 1 / (1 + y2 * rdyc2);
  wc = 0.5 * (1 - xsxc * rqc) * fyc;
  dwcx = hlwc2m * rqc2 * rqc * fyc;
  dwcy = drdyc2 * wc * fyc * y;
  szrp = 1 / (spl + zpl);
  szrm = 1 / (smn - zmn);
  xywc = x * dwcx + y * dwcy;
  wcsp = wc / spl;
  wcsm = wc / smn;
  fxyp = wcsp * szrp;
  fxym = wcsm * szrm;
  fxpl = x * fxyp;
  fxmn = -x * fxym;
  fypl = y * fxyp;
  fymn = -y * fxym;
  fzpl = wcsp + xywc * szrp;
  fzmn = wcsm + xywc * szrm;
  der[0][2] = fxpl + fxmn;
  der[0][3] = (fxpl - fxmn) * sps;
  der[1][2] = fypl + fymn;
  der[1][3] = (fypl - fymn) * sps;
  der[2][2] = fzpl + fzmn;
  der[2][3] = (fzpl - fzmn) * sps;
  // now calculate contribution from Chapman-Ferraro sources + all other
  ex = Math.exp(x / dx);
  ec = ex * cps;
  es = ex * sps;
  ecz = ec * z;
  esz = es * z;
  eszy2 = esz * y2;
  eszz2 = esz * z2;
  ecz2 = ecz * z;
  esy = es * y;
  der[0][5] = ecz;
  der[0][6] = es;
  der[0][7] = esy * y;
  der[0][8] = esz * z;
  der[1][9] = ecz * y;
  der[1][10] = esy;
  der[1][11] = esy * y2;
  der[1][12] = esy * z2;
  der[2][13] = ec;
  der[2][14] = ec * y2;
  der[2][5] = ecz2 * w1;
  der[2][9] = ecz2 * w5;
  der[2][6] = esz * w2;
  der[2][10] = -esz;
  der[2][7] = eszy2 * w2;
  der[2][11] = eszy2 * w6;
  der[2][8] = eszz2 * w3;
  der[2][12] = eszz2 * w4;
  // finally, calculate net external magnetic field components, but first of all those for c.-f. field:
  sx1 = ak6 * der[0][5] + ak7 * der[0][6] + ak8 * der[0][7] + ak9 * der[0][8];
  sy1 =
    ak10 * der[1][9] +
    ak11 * der[1][10] +
    ak12 * der[1][11] +
    ak13 * der[1][12];
  sz1 =
    ak14 * der[2][13] +
    ak15 * der[2][14] +
    ak610 * ecz2 +
    ak711 * esz +
    ak812 * eszy2 +
    ak913 * eszz2;
  bxcl = ak3 * der[0][2] + ak4 * der[0][3];
  bycl = ak3 * der[1][2] + ak4 * der[1][3];
  bzcl = ak3 * der[2][2] + ak4 * der[2][3];
  bxt =
    ak1 * der[0][0] +
    ak2 * der[0][1] +
    bxcl +
    ak16 * der[0][15] +
    ak17 * der[0][16];
  byt =
    ak1 * der[1][0] +
    ak2 * der[1][1] +
    bycl +
    ak16 * der[1][15] +
    ak17 * der[1][16];
  bzt =
    ak1 * der[2][0] +
    ak2 * der[2][1] +
    bzcl +
    ak16 * der[2][15] +
    ak17 * der[2][16];
  fx = bxt + ak5 * der[0][4] + sx1 + sxa;
  fy = byt + ak5 * der[1][4] + sy1 + sya;
  fz = bzt + ak5 * der[2][4] + sz1 + sza;
  return { x: fx, y: fy, z: fz };
}
