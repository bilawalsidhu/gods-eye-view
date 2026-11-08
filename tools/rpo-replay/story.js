// v4 storyboard: a list of shots separated by hard cuts. Each shot owns its
// clock. `true` shots run Earth, sun, both satellites and the camera on one
// physical clock (a real time-lapse: day and night cycle, the ground rushes
// by). `ff` (fast-forward) shots are too fast for that to read, so the Earth
// and X36's place on its orbit advance on a slow display clock while the
// relative motion runs at the stated rate; they carry a FAST-FORWARD badge.
//
// Camera keys use X36's local frame (R up, T velocity, N orbit normal):
//   dist (m) or f × separation; az 0 = behind X36 looking forward; el up;
//   look 0 = X36 … 1 = Cosmos; earth pulls the aim toward Earth's centre;
//   frame 'inertial' freezes the basis at the shot start (wide shots);
//   vup (portrait) rolls the camera so the direction of flight points up;
//   rtrail = Cosmos relative-path trail (hours); atrail = orbit trails (min);
//   mag/mx = fixed model enlargement; pairD/pairTh = pair-locked true-size cam.

export function buildStory({ sec, D }) {
  const CA = sec(D.ca.t);
  const M = 60;
  const iso = (s) => sec(s);
  const WIDE = { frame: 'inertial', look: 0, earth: 0.86, f: 0, fov: 40, mag: 0, sun: 0.5 };

  const shots = [
    {
      id: 'hook', mode: 'true', s0: 0, s1: 3.6, blur: 2,
      tau: [[0, CA - 7 * M], [3.6, CA - 2 * M]],
      cam: [
        { s: 0, dist: 1500, f: 2.6, az: 118, el: 18, look: 0.5, fov: 34, mag: 1, mx: 25, rtrail: 1.2, atrail: 4, vup: 1 },
        { s: 3.6, dist: 1300, f: 2.4, az: 104, el: 14, look: 0.5, fov: 34, mag: 1, mx: 25, rtrail: 1.2, atrail: 4, vup: 1 },
      ],
    },
    {
      id: 'climb', mode: 'true', s0: 3.6, s1: 10.6, blur: 3,
      tau: [[3.6, iso('2026-09-30T07:20:00Z')], [10.6, iso('2026-09-30T12:40:00Z')]],
      cam: [
        { s: 3.6, ...WIDE, dist: 3.1e7, az: 86, el: 38, atrail: 70, rtrail: 0 },
        { s: 10.6, ...WIDE, dist: 2.6e7, az: 104, el: 34, atrail: 70, rtrail: 0 },
      ],
    },
    {
      id: 'lap', mode: 'ff', s0: 10.6, s1: 14.6, blur: 1, bgRate: 260,
      tau: [[10.6, iso('2026-09-30T13:00:00Z')], [14.6, iso('2026-10-11T23:40:00Z')]],
      cam: [
        { s: 10.6, ...WIDE, dist: 2.7e7, az: 100, el: 36, atrail: 0, rtrail: 30 },
        { s: 14.6, ...WIDE, dist: 2.3e7, az: 124, el: 30, atrail: 0, rtrail: 30 },
      ],
    },
    {
      id: 'drop', mode: 'true', s0: 14.6, s1: 19.6, blur: 4,
      tau: [[14.6, iso('2026-10-12T00:00:00Z')], [19.6, iso('2026-10-12T03:30:00Z')]],
      cam: [
        { s: 14.6, dist: 2.4e5, f: 2.6, az: 62, el: 28, look: 0.5, fov: 36, mag: 0, rtrail: 3, atrail: 20, vup: 1 },
        { s: 17.0, dist: 3.0e5, f: 2.6, az: 48, el: 30, look: 0.5, fov: 36, mag: 0, rtrail: 4, atrail: 20, vup: 1 },
        { s: 19.6, dist: 4.0e5, f: 2.6, az: 34, el: 32, look: 0.5, fov: 36, mag: 0, rtrail: 4, atrail: 20, vup: 1 },
      ],
    },
    {
      id: 'close', mode: 'ff', s0: 19.6, s1: 23.2, blur: 1, bgRate: 140,
      tau: [[19.6, iso('2026-10-12T03:40:00Z')], [21.4, iso('2026-10-15T06:00:00Z')], [23.2, iso('2026-10-16T07:00:00Z')]],
      cam: [
        { s: 19.6, dist: 1.0e6, f: 2.8, az: 30, el: 34, look: 0.5, fov: 34, mag: 0, rtrail: 30, atrail: 0, vup: 1 },
        { s: 23.2, dist: 2.0e4, f: 2.8, az: 46, el: 34, look: 0.5, fov: 34, mag: 0, rtrail: 30, atrail: 0, vup: 1 },
      ],
    },
    {
      id: 'dance', mode: 'true', s0: 23.2, s1: 29.2, blur: 5,
      tau: [[23.2, iso('2026-10-16T07:10:00Z')], [29.2, iso('2026-10-16T12:10:00Z')]],
      cam: [
        { s: 23.2, dist: 5.5e3, f: 1.7, az: 62, el: 30, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 3, atrail: 1.2, vup: 1 },
        { s: 29.2, dist: 5.0e3, f: 1.7, az: 84, el: 24, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 3, atrail: 1.2, vup: 1 },
      ],
    },
    {
      id: 'dance-ff', mode: 'ff', s0: 29.2, s1: 31.2, blur: 1, bgRate: 140,
      tau: [[29.2, iso('2026-10-16T12:20:00Z')], [31.2, iso('2026-10-17T22:20:00Z')]],
      cam: [
        { s: 29.2, dist: 4.5e3, f: 1.7, az: 70, el: 40, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 12, atrail: 0, vup: 1 },
        { s: 31.2, dist: 3.4e3, f: 1.7, az: 92, el: 34, look: 0.5, fov: 38, mag: 1, mx: 40, rtrail: 12, atrail: 0, vup: 1 },
      ],
    },
    {
      id: 'approach', mode: 'true', s0: 31.2, s1: 35.4, blur: 4,
      tau: [[31.2, iso('2026-10-17T22:30:00Z')], [33.4, CA - 40 * M], [35.4, CA - 4 * M]],
      cam: [
        { s: 31.2, dist: 3.0e3, f: 1.7, az: 96, el: 26, look: 0.5, fov: 38, mag: 1, mx: 30, rtrail: 3, atrail: 1.5, vup: 1 },
        { s: 35.4, dist: 1.2e3, f: 2.2, az: 112, el: 18, look: 0.5, fov: 36, mag: 1, mx: 25, rtrail: 1.6, atrail: 1.5, vup: 1 },
      ],
    },
    {
      id: 'ca', mode: 'true', s0: 35.4, s1: 37.4, blur: 2,
      tau: [[35.4, CA - 4 * M], [37.4, CA + 1.5 * M]],
      cam: [
        { s: 35.4, dist: 26, az: 160, el: 0, look: 0, fov: 34, mag: 0, rtrail: 0.4, atrail: 0.6, comp: 0, pairD: 26, pairTh: 22 },
        { s: 37.4, dist: 22, az: 163, el: 0, look: 0, fov: 34, mag: 0, rtrail: 0.4, atrail: 0.6, comp: 0, pairD: 22, pairTh: 18 },
      ],
    },
    {
      id: 'sunrise', mode: 'true', s0: 37.4, s1: 40.0, blur: 2,
      tau: [[37.4, CA + 2 * M], [40.0, CA + 27 * M]],
      cam: [
        { s: 37.4, dist: 1.3e3, f: 2.2, az: 96, el: 16, look: 0.5, fov: 36, mag: 1, mx: 25, rtrail: 1.6, atrail: 1.5, vup: 1 },
        { s: 40.0, dist: 2.2e3, f: 2.4, az: 104, el: 22, look: 0.5, fov: 36, mag: 1, mx: 25, rtrail: 2, atrail: 1.5, vup: 1 },
      ],
    },
    {
      id: 'leave', mode: 'ff', s0: 40.0, s1: 44.0, blur: 1, bgRate: 140,
      tau: [[40.0, CA + 30 * M], [42.0, iso('2026-10-19T08:00:00Z')], [44.0, iso('2026-10-21T12:00:00Z')]],
      cam: [
        { s: 40.0, dist: 1.2e4, f: 2.8, az: 110, el: 30, look: 0.4, fov: 36, mag: 1, mx: 40, rtrail: 8, atrail: 0, vup: 1 },
        { s: 42.0, dist: 4.0e5, f: 2.8, az: 70, el: 30, look: 0.5, fov: 34, mag: 0, rtrail: 30, atrail: 0, vup: 1 },
        { s: 44.0, dist: 1.6e6, f: 2.8, az: 44, el: 30, look: 0.5, fov: 34, mag: 0, rtrail: 60, atrail: 0, vup: 1 },
      ],
    },
    {
      id: 'end', mode: 'true', s0: 44.0, s1: 48.5, blur: 1,
      tau: [[44.0, iso('2026-10-21T12:00:00Z')], [48.5, iso('2026-10-21T14:00:00Z')]],
      cam: [
        { s: 44.0, ...WIDE, dist: 4.6e7, az: 82, el: 34, atrail: 60, rtrail: 0 },
        { s: 48.5, ...WIDE, dist: 4.2e7, az: 96, el: 32, atrail: 60, rtrail: 0 },
      ],
    },
  ];
  return { shots, duration: 48.5 };
}
