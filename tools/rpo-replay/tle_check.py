#!/usr/bin/env python3
"""Compare the reconstruction with the public element-set history (tle/*.tle)."""
import json, math, sys
from datetime import datetime, timedelta, timezone
import numpy as np
from sgp4.api import Satrec, jday

HERE = __file__.rsplit('/', 1)[0]
MU = 398600.4418


def load(path):
    L = [l.rstrip('\n') for l in open(path) if l.strip()]
    out = []
    for i in range(len(L)):
        if L[i].startswith('1 ') and i + 1 < len(L) and L[i + 1].startswith('2 '):
            s = Satrec.twoline2rv(L[i], L[i + 1])
            ep = datetime(2000, 1, 1, tzinfo=timezone.utc) + timedelta(days=s.jdsatepoch + s.jdsatepochF - 2451545.0 + 0.5)
            out.append((ep, s, L[i], L[i + 1]))
    out.sort(key=lambda x: x[0])
    return out


def st(s, d):
    jd, fr = jday(d.year, d.month, d.day, d.hour, d.minute, d.second + d.microsecond / 1e6)
    e, r, v = s.sgp4(jd, fr)
    return np.array(r), np.array(v)


def rel_rtn(rx, vx, rc):
    R = rx / np.linalg.norm(rx)
    N = np.cross(rx, vx); N /= np.linalg.norm(N)
    T = np.cross(N, R)
    th = math.atan2(np.dot(np.cross(rx, rc), N), np.dot(rx, rc))
    return np.array([np.linalg.norm(rc) - np.linalg.norm(rx), th * np.linalg.norm(rx), np.dot(rc, N)]) * 1000


def sma(s):
    n = s.no_kozai / 60
    return (MU / n ** 2) ** (1 / 3)


X = load(f'{HERE}/tle/59103.tle')
C = load(f'{HERE}/tle/68762.tle')
D = json.load(open(f'{HERE}/data.json'))
T0 = datetime.fromisoformat(D['t0'].replace('Z', '+00:00'))
rel = np.array(D['rel']).reshape(-1, 3)


def model_rel(d):
    i = (d - T0).total_seconds() / D['dt']
    if i < 0 or i >= len(rel) - 1:
        return None
    k = int(i)
    return rel[k] + (rel[k + 1] - rel[k]) * (i - k)


def nearest_x(d):
    return min(X, key=lambda x: abs((x[0] - d).total_seconds()))


rows = []
for ep, s, l1, l2 in C:
    if ep < datetime(2026, 9, 25, tzinfo=timezone.utc) or ep > datetime(2026, 10, 26, tzinfo=timezone.utc):
        continue
    xe, xs, _, _ = nearest_x(ep)
    rx, vx = st(xs, ep)
    rc, vc = st(s, ep)
    r = rel_rtn(rx, vx, rc)
    m = model_rel(ep)
    dA = sma(s) - sma(xs)
    di = math.degrees(s.inclo - xs.inclo)
    dO = math.degrees(s.nodeo - xs.nodeo)
    ec = (s.ecco * math.cos(s.argpo), s.ecco * math.sin(s.argpo))
    ex = (xs.ecco * math.cos(xs.argpo), xs.ecco * math.sin(xs.argpo))
    rows.append(dict(ep=ep.isoformat()[:16], xage_h=round((ep - xe).total_seconds() / 3600, 1), R=r[0], T=r[1], N=r[2], dA_km=dA, di=di, dO=dO,
                     dex=(ec[0] - ex[0]) * sma(xs) * 1000, dey=(ec[1] - ex[1]) * sma(xs) * 1000,
                     mT=None if m is None else m[1], mR=None if m is None else m[0]))
print(f"{'epoch':17} {'xAge':>5} {'TLE T km':>10} {'model T':>10} {'TLE R km':>9} {'mod R':>7} {'N km':>7} {'dA km':>8} {'di deg':>7} {'dRAAN':>7} {'|de| m':>7}")
for r in rows:
    print(f"{r['ep']:17} {r['xage_h']:5} {r['T']/1000:10.2f} {('' if r['mT'] is None else f'{r[chr(109)+chr(84)]/1000:10.2f}'):>10} {r['R']/1000:9.2f} {('' if r['mR'] is None else f'{r[chr(109)+chr(82)]/1000:7.2f}'):>7} {r['N']/1000:7.2f} {r['dA_km']:8.3f} {r['di']:7.3f} {r['dO']:7.3f} {math.hypot(r['dex'], r['dey']):7.0f}")
json.dump(rows, open(f'{HERE}/tle_rows.json', 'w'), default=str, indent=0)
