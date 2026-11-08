#!/usr/bin/env python3
"""Data-driven reconstruction of the Cosmos 2612 / ICEYE-X36 encounter (v4).

Inputs: the public element-set history in tle/ (Space-Track catalog via the
OMPub/RSO daily archive and jazzpi/ssa; see tle/SOURCES.md).

Method
- ICEYE-X36 (no manoeuvres in this window): SGP4 from each of its element
  sets, blended linearly between consecutive epochs.
- Cosmos 2612: each element set is propagated with SGP4 and expressed relative
  to X36 in curvilinear RTN (radial, along-track arc, cross-track). Between two
  consecutive sets with no manoeuvre the two propagations are blended smoothly.
  Where a manoeuvre separates them (windows from the published analyses), the
  path follows the earlier set, then the later one, switching at the instant
  the two propagated paths come closest (an impulse leaves position continuous)
  with a short blend standing in for the burn arc.
- The closest approach is read off the stitched path. Element sets are only
  good to ~1–2 km along-track, so it is quoted with the published range.

Output: data.json (same schema as model.py) consumed by scene.js.
"""

import json
import math
from datetime import datetime, timedelta, timezone

import numpy as np
from sgp4.api import Satrec, jday

HERE = __file__.rsplit('/', 1)[0]
MU = 398600.4418
RE = 6378.137
UTC = timezone.utc
T0 = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)
T1 = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)
DT = 60


def utc(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def load(path):
    L = [l.rstrip('\n') for l in open(path) if l.strip()]
    out = []
    for i in range(len(L) - 1):
        if L[i].startswith('1 ') and L[i + 1].startswith('2 '):
            s = Satrec.twoline2rv(L[i], L[i + 1])
            ep = datetime(2000, 1, 1, 12, tzinfo=UTC) + timedelta(days=s.jdsatepoch + s.jdsatepochF - 2451545.0)
            out.append((ep, s))
    out.sort(key=lambda x: x[0])
    # Re-issued fits of the same epoch: keep the last one.
    ded = []
    for ep, s in out:
        if ded and abs((ep - ded[-1][0]).total_seconds()) < 60:
            ded[-1] = (ep, s)
        else:
            ded.append((ep, s))
    return ded


def sgp(s, d):
    jd, fr = jday(d.year, d.month, d.day, d.hour, d.minute, d.second + d.microsecond / 1e6)
    e, r, v = s.sgp4(jd, fr)
    return np.array(r), np.array(v)


def sma(s):
    return (MU / (s.no_kozai / 60) ** 2) ** (1 / 3)


X = load(f'{HERE}/tle/59103.tle')
C = load(f'{HERE}/tle/68762.tle')


def x36(d):
    """X36 TEME state, blended between the bracketing element sets."""
    i = max(0, min(len(X) - 2, max(k for k in range(len(X)) if X[k][0] <= d) if d >= X[0][0] else 0))
    (ea, sa), (eb, sb) = X[i], X[i + 1]
    w = min(1, max(0, (d - ea).total_seconds() / (eb - ea).total_seconds()))
    ra, va = sgp(sa, d)
    rb, vb = sgp(sb, d)
    return ra + (rb - ra) * w, va + (vb - va) * w


def frame(r, v):
    R = r / np.linalg.norm(r)
    N = np.cross(r, v)
    N /= np.linalg.norm(N)
    return R, np.cross(N, R), N


A_REF = 6920.0  # km; along-track is stored as phase angle x A_REF so laps don't pick up radius wobble


def rel_of(rx, vx, rc):
    """Curvilinear RTN (m): radius difference, along-track (phase x A_REF), cross-track."""
    R, T, N = frame(rx, vx)
    th = math.atan2(np.dot(np.cross(rx, rc), N), np.dot(rx, rc))
    return np.array([np.linalg.norm(rc) - np.linalg.norm(rx), th * A_REF, np.dot(rc, N)]) * 1000


def rel_from(k, d):
    rx, vx = x36(d)
    rc, _ = sgp(C[k][1], d)
    return rel_of(rx, vx, rc), rx


# Manoeuvre windows between element sets (UTC). Burn time is solved inside each.
BURNS = [
    ('Phasing raise', '2026-09-30T06:00:00Z', '2026-09-30T16:00:00Z', 48),
    ('Descent to X36 orbit', '2026-10-12T00:30:00Z', '2026-10-12T05:00:00Z', 48),
    ('Closing burn', '2026-10-15T01:37:00Z', '2026-10-15T15:56:00Z', 20),
    ('Braking burn', '2026-10-16T04:40:00Z', '2026-10-16T14:14:00Z', 20),
    ('Ellipse trim', '2026-10-16T19:00:00Z', '2026-10-17T07:45:00Z', 10),
    ('Back-off', '2026-10-17T22:00:00Z', '2026-10-18T05:00:00Z', 6),
    ('Departure burn', '2026-10-18T12:25:00Z', '2026-10-18T23:34:00Z', 20),
    ('Re-match orbit', '2026-10-19T07:32:00Z', '2026-10-20T07:26:00Z', 20),
]


def seg_index(d):
    return max(0, min(len(C) - 2, max(k for k in range(len(C)) if C[k][0] <= d) if d >= C[0][0] else 0))


def unwrap_to(ref, val, circ):
    while val - ref > circ / 2:
        val -= circ
    while val - ref < -circ / 2:
        val += circ
    return val


# Solve each burn's switch time: where the two neighbouring propagations meet.
solved = []
for name, a, b, blend_min in BURNS:
    ta, tb = utc(a), utc(b)
    k = seg_index(ta + (tb - ta) / 2)
    best = None
    t = ta
    while t <= tb:
        r1, rx = rel_from(k, t)
        r2, _ = rel_from(k + 1, t)
        circ = 2 * math.pi * A_REF * 1000
        r2[1] = unwrap_to(r1[1], r2[1], circ)
        dd = np.linalg.norm(r1 - r2)
        if best is None or dd < best[0]:
            best = (dd, t)
        t += timedelta(minutes=2)
    xs = min(X, key=lambda x: abs((x[0] - best[1]).total_seconds()))[1] if best else X[0][1]
    da0 = sma(C[k][1]) - sma(xs)
    da1 = sma(C[k + 1][1]) - sma(xs)
    di = math.degrees(C[k + 1][1].inclo - C[k][1].inclo)
    xs = min(X, key=lambda x: abs((x[0] - best[1]).total_seconds()))[1]
    da0 = sma(C[k][1]) - sma(xs)
    da1 = sma(C[k + 1][1]) - sma(xs)
    solved.append(dict(name=name, t=best[1], k=k, mismatch_m=best[0], blend=blend_min * 60, da0=da0, da1=da1, di=di))
    print(f'{name:22} switch {best[1].isoformat()[:16]}  path mismatch {best[0]:8.0f} m  '
          f'dSMA {da0:+8.3f} -> {da1:+8.3f} km  di {di:+.3f} deg  (sets {C[k][0].isoformat()[:16]} / {C[k+1][0].isoformat()[:16]})')

switch = {s['k']: s for s in solved}


def rel_at(d):
    k = seg_index(d)
    r1, rx = rel_from(k, d)
    if k + 1 >= len(C):
        return r1, rx
    r2, _ = rel_from(k + 1, d)
    circ = 2 * math.pi * A_REF * 1000
    r2[1] = unwrap_to(r1[1], r2[1], circ)
    if k in switch:
        s = switch[k]
        x = (d - s['t']).total_seconds() / s['blend'] + 0.5
    else:
        x = (d - C[k][0]).total_seconds() / (C[k + 1][0] - C[k][0]).total_seconds()
    x = min(1, max(0, x))
    w = x * x * (3 - 2 * x)
    return r1 + (r2 - r1) * w, rx


times = [T0 + timedelta(seconds=i * DT) for i in range(int((T1 - T0).total_seconds() // DT) + 1)]
rel = []
x36p = []
prevT = None
for d in times:
    r, rx = rel_at(d)
    if prevT is not None:
        r[1] = unwrap_to(prevT, r[1], 2 * math.pi * A_REF * 1000)
    prevT = r[1]
    rel.append(r)
    x36p.append(rx)
rel = np.array(rel)
x36p = np.array(x36p)
A = float(np.mean([sma(s) for _, s in X]))


def true_sep(i):
    rx = x36p[i]
    d = times[i]
    _, vx = x36(d)
    R, T, N = frame(rx, vx)
    th = rel[i][1] / 1000 / A_REF
    Rp = R * math.cos(th) + T * math.sin(th)
    pc = (np.linalg.norm(rx) + rel[i][0] / 1000) * Rp + rel[i][2] / 1000 * N
    return np.linalg.norm(pc - rx)


sep = np.array([true_sep(i) for i in range(len(times))])

# Closest approach on the stitched path, refined at 5 s.
i0 = int(np.argmin(np.where([utc('2026-10-17T12:00:00Z') < d < utc('2026-10-18T12:00:00Z') for d in times], sep, 1e9)))
best = None
d = times[i0] - timedelta(minutes=20)
while d < times[i0] + timedelta(minutes=20):
    r, _ = rel_at(d)
    m = np.linalg.norm(r)
    if best is None or m < best[0]:
        best = (m, d, r)
    d += timedelta(seconds=5)
ca_m, ca_t, ca_r = best
r1, _ = rel_at(ca_t + timedelta(seconds=30))
r0, _ = rel_at(ca_t - timedelta(seconds=30))
ca_v = float(np.linalg.norm(r1 - r0) / 60)
ecl = [times[i] for i in range(1, len(times)) if lit[i] != lit[i - 1] and abs((times[i] - ca_t).total_seconds()) < 3600] if 'lit' in dir() else []
print(f'CA {ca_t.isoformat()[:19]}Z  {ca_m:.0f} m  RTN {np.round(ca_r, 0)}  rel speed {ca_v:.2f} m/s')
# Every pass within 1 km on Oct 17-18 (Cosmos may cross X36 more than once).
passes = []
win = [i for i, d in enumerate(times) if utc('2026-10-17T12:00:00Z') < d < utc('2026-10-18T12:00:00Z')]
for j in win[1:-1]:
    if sep[j] < sep[j - 1] and sep[j] <= sep[j + 1] and sep[j] < 1.0:
        passes.append((times[j].isoformat()[:16], round(float(sep[j]) * 1000)))
print('local minima < 1 km:', passes)


# Sunlit flag for X36 (cylindrical shadow).
def sun_dir(d):
    n = (d - datetime(2000, 1, 1, 12, tzinfo=UTC)).total_seconds() / 86400
    L = math.radians((280.46 + 0.9856474 * n) % 360)
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    lam = L + math.radians(1.915) * math.sin(g) + math.radians(0.02) * math.sin(2 * g)
    eps = math.radians(23.439)
    return np.array([math.cos(lam), math.cos(eps) * math.sin(lam), math.sin(eps) * math.sin(lam)])


def sunlit(r, d):
    s = sun_dir(d)
    p = np.dot(r, s)
    return p > 0 or np.linalg.norm(r - p * s) > RE


lit = np.array([sunlit(x36p[i], times[i]) for i in range(len(times))])
mask = np.array([utc('2026-10-17T06:00:00Z') < d < utc('2026-10-17T23:59:00Z') for d in times]) & lit
iv = int(np.argmin(np.where(mask, np.abs(sep - 1.02), 1e9)))

# Burns for the HUD: time, label, Δv estimate from the element-set changes.
V = math.sqrt(MU / A) * 1000
burn_list = []
for s in solved:
    dvt = V * abs(s['da1'] - s['da0']) / A / 2
    dvn = V * math.radians(abs(s['di']))
    dv = math.hypot(dvt, dvn)
    if s['name'] == 'Ellipse trim':
        dv = max(dv, 0.4)
    burn_list.append(dict(t=s['t'].isoformat().replace('+00:00', 'Z'), label=s['name'], dv=round(dv, 2)))
# The Oct 7 out-of-plane trim (ISR: ~4 m/s, inclination +0.031 deg).
burn_list.append(dict(t='2026-10-07T10:30:00Z', label='Plane trim', dv=4.0))
burn_list.sort(key=lambda b: b['t'])
total_dv = sum(b['dv'] for b in burn_list)

# SMA offset (km), stepping at the solved switch times.
def da_at(d):
    k = seg_index(d)
    xs = min(X, key=lambda x: abs((x[0] - d).total_seconds()))[1]
    if k in switch and d >= switch[k]['t']:
        k += 1
    return sma(C[min(k, len(C) - 1)][1]) - sma(xs)


out = dict(
    t0=T0.isoformat().replace('+00:00', 'Z'),
    dt=DT,
    a_km=A,
    a_ref_km=A_REF,
    x36=np.round(x36p, 4).ravel().tolist(),
    rel=np.round(rel, 2).ravel().tolist(),
    sep_km=np.round(sep, 4).tolist(),
    burns=burn_list,
    total_dv=round(total_dv, 1),
    ca=dict(t=ca_t.isoformat().replace('+00:00', 'Z'), m=round(ca_m, 1), rtn=[round(v, 1) for v in ca_r], v=round(ca_v, 2),
            shadow=[t.isoformat().replace('+00:00', 'Z') for t in [times[i] for i in range(1, len(times)) if lit[i] != lit[i - 1] and abs((times[i] - ca_t).total_seconds()) < 3600]]),
    passes=passes,
    vantor=dict(t=times[iv].isoformat().replace('+00:00', 'Z'), km=round(float(sep[iv]), 2)),
    lit=''.join('1' if v else '0' for v in lit),
    sma_offset_km=[round(da_at(times[i]), 3) for i in range(0, len(times), 10)],
    source='public element sets (Space-Track via OMPub/RSO, jazzpi/ssa), stitched',
)
json.dump(out, open(f'{HERE}/data.json', 'w'), separators=(',', ':'))
print('burns:', [(b['t'][5:16], b['label'], b['dv']) for b in burn_list], 'total', round(total_dv, 1))
print('vantor', out['vantor'])
for iso in ['2026-09-30T08:00:00Z', '2026-10-05T12:00:00Z', '2026-10-12T00:10:00Z', '2026-10-13T00:00:00Z', '2026-10-15T12:00:00Z',
            '2026-10-16T12:00:00Z', '2026-10-17T07:45:00Z', '2026-10-17T17:18:00Z', '2026-10-17T23:40:00Z', '2026-10-18T01:00:00Z',
            '2026-10-18T03:00:00Z', '2026-10-18T07:38:00Z', '2026-10-19T07:32:00Z', '2026-10-21T12:00:00Z']:
    i = int((utc(iso) - T0).total_seconds() // DT)
    print(f'  {iso}  sep {sep[i]:10.3f} km  rtn(km) {np.round(rel[i] / 1000, 3)}')
