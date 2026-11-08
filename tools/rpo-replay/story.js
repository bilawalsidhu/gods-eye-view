// Storyboard (v5): a list of shots separated by hard cuts. Each shot owns its
// clock. `true` shots run Earth, sun, both satellites and the camera on one
// physical clock (a real time-lapse: day and night cycle, the ground rushes
// by). `ff` (fast-forward) shots are too fast for that to read, so the Earth
// and X36's place on its orbit advance on a slow display clock while the
// relative motion runs at the stated rate; they carry a FAST-FORWARD badge.
//
// Camera keys use X36's local frame (R up, T velocity, N orbit normal):
//   dist (m) or f × guiding separation; az 0 = behind X36 looking forward;
//   el up; look 0 = X36 … 1 = Cosmos's guiding centre; earth pulls the aim
//   toward Earth's centre; frame 'inertial' freezes the basis at the shot
//   start (wide shots); vup (portrait) rolls the camera so the direction of
//   flight points up; rtrail = Cosmos relative-path trail (hours);
//   atrail = orbit trails (min); mag/mx = fixed model enlargement;
//   pairD/pairTh = pair-locked true-size camera; inset = hours of path shown
//   in the "seen from X36" inset.

export function buildStory({ sec, D }) {
  const CA = sec(D.ca.t);
  const M = 60;
  const iso = (s) => sec(s);
  const WIDE = { frame: 'inertial', look: 0, earth: 0.86, f: 0, fov: 40, mag: 0, sun: 0.35 };

  const shots = [
    {
      id: 'hook', mode: 'true', s0: 0, s1: 3.6, blur: 1, inset: 1,
      tau: [[0, CA - 13 * M], [3.6, CA - 6 * M]],
      cam: [
        { s: 0, dist: 1300, f: 2.4, az: 120, el: 20, look: 0.5, fov: 34, mag: 1, mx: 25, rtrail: 1.0, atrail: 2, vup: 1, compY: -0.16 },
        { s: 3.6, dist: 1100, f: 2.2, az: 108, el: 16, look: 0.5, fov: 34, mag: 1, mx: 25, rtrail: 1.0, atrail: 2, vup: 1, compY: -0.16 },
      ],
    },
    {
      id: 'climb', mode: 'true', s0: 3.6, s1: 9.6, blur: 1, inset: 6,
      tau: [[3.6, iso('2026-09-30T07:30:00Z')], [9.6, iso('2026-09-30T12:30:00Z')]],
      cam: [
        { s: 3.6, ...WIDE, dist: 3.3e7, az: 92, el: 28, atrail: 80, rtrail: 0 },
        { s: 9.6, ...WIDE, dist: 2.9e7, az: 100, el: 24, atrail: 80, rtrail: 0 },
      ],
    },
    {
      id: 'lap', mode: 'ff', s0: 9.6, s1: 13.6, blur: 1, bgRate: 260, inset: 30,
      tau: [[9.6, iso('2026-09-30T13:00:00Z')], [13.6, iso('2026-10-11T23:40:00Z')]],
      cam: [
        { s: 9.6, ...WIDE, dist: 2.9e7, az: 100, el: 30, atrail: 0, rtrail: 30 },
        { s: 13.6, ...WIDE, dist: 2.5e7, az: 116, el: 28, atrail: 0, rtrail: 30 },
      ],
    },
    {
      id: 'drop', mode: 'true', s0: 13.6, s1: 18.6, blur: 3, inset: 4,
      tau: [[13.6, iso('2026-10-12T00:00:00Z')], [18.6, iso('2026-10-12T03:30:00Z')]],
      cam: [
        { s: 13.6, dist: 2.4e5, f: 2.6, az: 62, el: 28, look: 0.5, fov: 36, mag: 0, rtrail: 3, atrail: 20, vup: 1 },
        { s: 16.0, dist: 3.0e5, f: 2.6, az: 48, el: 30, look: 0.5, fov: 36, mag: 0, rtrail: 4, atrail: 20, vup: 1 },
        { s: 18.6, dist: 4.0e5, f: 2.6, az: 34, el: 32, look: 0.5, fov: 36, mag: 0, rtrail: 4, atrail: 20, vup: 1 },
      ],
    },
    {
      id: 'close', mode: 'ff', s0: 18.6, s1: 22.0, blur: 1, bgRate: 140, inset: 30,
      tau: [[18.6, iso('2026-10-12T03:40:00Z')], [20.3, iso('2026-10-15T06:00:00Z')], [22.0, iso('2026-10-16T07:00:00Z')]],
      cam: [
        { s: 18.6, dist: 1.0e6, f: 2.8, az: 30, el: 34, look: 0.5, fov: 34, mag: 0, rtrail: 30, atrail: 0, vup: 1 },
        { s: 22.0, dist: 2.0e4, f: 2.8, az: 46, el: 34, look: 0.5, fov: 34, mag: 0, rtrail: 30, atrail: 0, vup: 1 },
      ],
    },
    {
      id: 'dance', mode: 'true', s0: 22.0, s1: 28.0, blur: 5, inset: 3.2,
      tau: [[22.0, iso('2026-10-16T07:10:00Z')], [28.0, iso('2026-10-16T12:10:00Z')]],
      cam: [
        { s: 22.0, dist: 5.5e3, f: 1.7, az: 62, el: 30, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 3, atrail: 1.2, vup: 1 },
        { s: 28.0, dist: 5.0e3, f: 1.7, az: 80, el: 26, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 3, atrail: 1.2, vup: 1 },
      ],
    },
    {
      id: 'dance-ff', mode: 'ff', s0: 28.0, s1: 30.0, blur: 1, bgRate: 140, inset: 10,
      tau: [[28.0, iso('2026-10-16T12:20:00Z')], [30.0, iso('2026-10-17T22:20:00Z')]],
      cam: [
        { s: 28.0, dist: 4.5e3, f: 1.7, az: 72, el: 38, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 12, atrail: 0, vup: 1 },
        { s: 30.0, dist: 3.4e3, f: 1.7, az: 90, el: 32, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 12, atrail: 0, vup: 1 },
      ],
    },
    {
      id: 'approach', mode: 'true', s0: 30.0, s1: 33.6, blur: 3, inset: 3,
      tau: [[30.0, iso('2026-10-17T22:30:00Z')], [32.0, CA - 40 * M], [33.6, CA - 5 * M]],
      cam: [
        { s: 30.0, dist: 3.0e3, f: 1.7, az: 96, el: 26, look: 0.5, fov: 38, mag: 1, mx: 30, rtrail: 3, atrail: 1.5, vup: 1 },
        { s: 33.6, dist: 1.4e3, f: 1.7, az: 112, el: 18, look: 0.5, fov: 36, mag: 1, mx: 25, rtrail: 1.6, atrail: 1.5, vup: 1 },
      ],
    },
    {
      id: 'ca', mode: 'true', s0: 33.6, s1: 36.6, blur: 1, inset: 1, noSky: true,
      tau: [[33.6, CA - 4 * M], [36.6, CA + 2 * M]],
      cam: [
        { s: 33.6, dist: 26, az: 160, el: 0, look: 0, fov: 34, mag: 0, rtrail: 0.4, atrail: 0.6, comp: 0, pairD: 26, pairTh: 24 },
        { s: 36.6, dist: 20, az: 163, el: 0, look: 0, fov: 34, mag: 0, rtrail: 0.4, atrail: 0.6, comp: 0, pairD: 20, pairTh: 14 },
      ],
    },
    {
      id: 'sunrise', mode: 'true', s0: 36.6, s1: 39.0, blur: 1, inset: 1.2,
      tau: [[36.6, CA + 6 * M], [39.0, CA + 27 * M]],
      cam: [
        { s: 36.6, dist: 1.3e3, f: 2.2, az: 96, el: 16, look: 0.5, fov: 36, mag: 1, mx: 25, rtrail: 1.6, atrail: 1.5, vup: 1 },
        { s: 39.0, dist: 2.2e3, f: 2.4, az: 104, el: 22, look: 0.5, fov: 36, mag: 1, mx: 25, rtrail: 2, atrail: 1.5, vup: 1 },
      ],
    },
    {
      id: 'leave', mode: 'ff', s0: 39.0, s1: 42.4, blur: 1, bgRate: 140, inset: 40,
      tau: [[39.0, CA + 30 * M], [40.8, iso('2026-10-19T08:00:00Z')], [42.4, iso('2026-10-21T12:00:00Z')]],
      cam: [
        { s: 39.0, dist: 1.2e4, f: 2.8, az: 110, el: 30, look: 0.4, fov: 36, mag: 1, mx: 40, rtrail: 8, atrail: 0, vup: 1 },
        { s: 40.8, dist: 4.0e5, f: 2.8, az: 70, el: 30, look: 0.5, fov: 34, mag: 0, rtrail: 30, atrail: 0, vup: 1 },
        { s: 42.4, dist: 1.6e6, f: 2.8, az: 44, el: 30, look: 0.5, fov: 34, mag: 0, rtrail: 60, atrail: 0, vup: 1 },
      ],
    },
    {
      id: 'end', mode: 'true', s0: 42.4, s1: 45.4, blur: 1, inset: 0,
      tau: [[42.4, iso('2026-10-21T12:00:00Z')], [45.4, iso('2026-10-21T13:30:00Z')]],
      cam: [
        { s: 42.4, ...WIDE, dist: 3.4e7, az: 92, el: 28, atrail: 80, rtrail: 0 },
        { s: 45.4, ...WIDE, dist: 3.1e7, az: 100, el: 26, atrail: 80, rtrail: 0 },
      ],
    },
  ];
  return { shots, duration: 45.4 };
}
