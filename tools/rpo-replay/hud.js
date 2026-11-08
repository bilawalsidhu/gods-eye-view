// HUD for the RPO replay (v4), sized for phone playback: a 16:9 video in a
// feed plays ~390 px wide (≈0.2×), so body copy is ≥34 px at 1080p and nothing
// that must be read is under ~24 px. Animation is a function of video time `s`,
// except label placement, which carries state between consecutive frames so
// labels hold their side (hysteresis) and ease instead of jumping.

export function createHud(ctx) {
  const { D, W, H, U, PORTRAIT, sec, rate, sOfTau, CA_T, VANTOR_T, BURNS, CUTS, SHOTS, shotAt, DUR, project } = ctx;
  const $ = (q) => document.querySelector(q);
  const CA_M = Math.round(D.ca.m / 5) * 5;
  const END = SHOTS.find((x) => x.id === 'end').s0;

  // -------------------------------------------------------------------------
  // Story
  // -------------------------------------------------------------------------
  const span = (id) => {
    const x = SHOTS.find((sh) => sh.id === id);
    return [x.s0, x.s1];
  };
  const CHAPTERS = [
    { key: 'climb', label: 'Climb', s0: span('climb')[0], s1: span('lap')[1] },
    { key: 'drop', label: 'Drop in', s0: span('drop')[0], s1: span('close')[1] },
    { key: 'dance', label: 'Close in', s0: span('dance')[0], s1: span('approach')[1] },
    { key: 'closest', label: 'Closest', s0: span('ca')[0], s1: span('sunrise')[1] },
    { key: 'leave', label: 'Leave', s0: span('leave')[0], s1: span('leave')[1] },
  ];
  const cap = (id, title, body, extra = {}) => ({ s0: span(id)[0], s1: span(id)[1], title, body, ...extra });
  const CAPTIONS = [
    cap('hook', `A Russian military satellite came within <span class="c-cos nw">~${CA_M} m</span> of a U.S.-registered one`,
      'This is how it got there, rebuilt from public tracking data.', { hook: true, s0: -1 }),
    cap('climb', 'Climb higher to fall behind',
      'Same orbit, a quarter-orbit apart. Two burns lift <b class="c-cos">Cosmos 2612</b> <b>47 km</b>, and a higher orbit is a slower one.'),
    cap('lap', 'Fall behind, and lap it',
      'Drifting back <b>~6,700 km a day</b>, it laps almost twice, passing over <b class="c-x36">X36</b> on Oct 5 and Oct 12, as its orbit plane swings into line.'),
    cap('drop', 'Drop into the same orbit',
      'Oct 12: from <b>47 km</b> directly overhead it dives into X36\'s orbit, and lands about <b>480 km behind</b>.'),
    cap('close', 'Speed up, then brake',
      'A 2 km dip makes it faster, closing <b>~350 km a day</b>. Then it brakes 3 km behind.'),
    cap('dance', 'The dance',
      'Every orbit is a day and a night. Each one, Cosmos loops <b>~1.5 km</b> around X36, 3 km behind it.'),
    cap('dance-ff', 'Flatten the loops',
      'A tiny burn puts Cosmos almost exactly in X36\'s path. It creeps in <b>~3 km a day</b>.'),
    cap('approach', 'Closing in, slowly',
      'Creeping in at <b>a few centimetres per second</b>, while both fly at <b>27,000 km/h</b>.'),
    cap('ca', `Closest pass: <span class="c-cos nw">~${CA_M} m</span>`,
      'True size. LeoLabs measured <b>~500 m</b>; other estimates run <b>150 to 650 m</b>.'),
    cap('sunrise', 'Then the sun comes up',
      'Twenty minutes later both leave Earth\'s shadow. Within hours, Cosmos backs away.'),
    cap('leave', 'Back off, and wait',
      'It drifts back <b>~350 km a day</b>. By Oct 25 it sat <b>~480 km behind</b>, in the same orbit.'),
  ];
  const BURN_NOTES = {
    'Phasing raise': 'raises its orbit 46 km',
    'Plane trim': 'tilts its orbit into line',
    'Descent to X36 orbit': 'drops 47 km into X36\'s orbit',
    'Closing burn': 'dips 2.3 km to speed up',
    'Braking burn': 'rises 2.5 km to stop',
    'Back-off': 'rises 140 m and starts to drift back',
    'Ellipse trim': 'flattens its loops',
    'Departure burn': 'rises 2.4 km to drift away',
    'Re-match orbit': 'drops 2.6 km to hold position',
  };
  const EVENTS = [
    ...BURNS.map((b) => ({
      t: b.t, kind: 'burn', title: 'Engine burn',
      sub: `${BURN_NOTES[b.label] || b.label} · Δv ${b.dv < 1 ? b.dv.toFixed(1) : Math.round(b.dv)} m/s`,
    })),
    { t: sec('2026-10-05T12:28:00Z'), kind: 'note', title: 'Passes overhead', sub: '55 km above its target' },
    { t: sec('2026-10-12T00:30:00Z'), kind: 'note', title: 'Directly overhead', sub: '54 km above its target' },
    { t: VANTOR_T, kind: 'vantor', title: 'Vantor photographs the pair', sub: `from its own satellite · ~${D.vantor.km.toFixed(0)} km apart · Oct 17` },
    { t: CA_T, kind: 'ca', title: 'Closest approach', sub: `${D.ca.t.slice(11, 16)} UTC, Oct 18 · in Earth's shadow` },
  ].map((e) => ({ ...e, s: sOfTau(e.t) })).filter((e) => e.s !== null).sort((a, b) => a.s - b.s);
  const caS = EVENTS.find((e) => e.kind === 'ca')?.s ?? 1e9;

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  const fade = (s, s0, s1, ramp = 0.4) => Math.min(1, Math.max(0, (s - s0) / ramp), Math.max(0, (s1 - s) / ramp));
  const capEl = $('#caption');
  const tagsEl = $('#tags');
  const leaders = $('#leaders');
  const evEl = $('#events');
  leaders.setAttribute('viewBox', `0 0 ${W} ${H}`);
  $('#chapters').innerHTML = CHAPTERS.map((c) => `<div class="ch" data-k="${c.key}"><i><b></b></i><span>${c.label}</span></div>`).join('');

  // Linear 22-day timeline with event markers (replaces the log chart).
  const TL = { t0: sec('2026-09-30T00:00:00Z'), t1: sec('2026-10-21T23:59:00Z') };
  const tlBox = $('#timeline');
  const timeline = (() => {
    const cw = tlBox.clientWidth;
    const ch = tlBox.clientHeight;
    const y = ch * 0.42;
    const x = (t) => ((t - TL.t0) / (TL.t1 - TL.t0)) * cw;
    const fs = (PORTRAIT ? 24 : 26) * U;
    let ticks = '';
    for (let d = 0; d <= 21; d++) {
      const t = sec(`2026-${d === 0 ? '09-30' : `10-${String(d).padStart(2, '0')}`}T00:00:00Z`);
      ticks += `<line x1="${x(t)}" x2="${x(t)}" y1="${y - 6 * U}" y2="${y + 6 * U}" stroke="rgba(244,247,250,0.3)" stroke-width="${1.5 * U}"/>`;
    }
    const labs = [['2026-09-30', 'SEP 30', 'start'], ['2026-10-12', 'OCT 12', 'middle'], ['2026-10-18', 'OCT 18', 'middle'], ['2026-10-21T23:59:00Z', 'OCT 21', 'end']]
      .map(([d, l, a]) => `<text x="${x(sec(d.length > 10 ? d : `${d}T00:00:00Z`))}" y="${ch - 2 * U}" text-anchor="${a}" font-size="${fs}" fill="rgba(244,247,250,0.66)">${l}</text>`).join('');
    const burns = BURNS.map((b) => `<circle class="burn" data-t="${b.t}" cx="${x(b.t)}" cy="${y}" r="${7 * U}" fill="#ffb547"/>`).join('');
    const ca = `<g class="camk" data-t="${CA_T}"><circle cx="${x(CA_T)}" cy="${y}" r="${10 * U}" fill="none" stroke="#fff" stroke-width="${3 * U}"/></g>`;
    tlBox.innerHTML = `<svg viewBox="0 0 ${cw} ${ch}">
      <line x1="0" x2="${cw}" y1="${y}" y2="${y}" stroke="rgba(244,247,250,0.22)" stroke-width="${4 * U}" stroke-linecap="round"/>
      <line id="tlDone" x1="0" x2="0" y1="${y}" y2="${y}" stroke="#ff5a3c" stroke-width="${4 * U}" stroke-linecap="round"/>
      ${ticks}${burns}${ca}${labs}
      <circle id="tlHead" cx="0" cy="${y}" r="${11 * U}" fill="#fff"/>
    </svg>`;
    return { x };
  })();

  function tag(id, name, cls) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'tag';
      el.innerHTML = `<div class="name ${cls}">${name}</div><div class="meta"></div>`;
      tagsEl.appendChild(el);
    }
    return el;
  }

  const fmtNum = (km) => (km >= 100 ? Math.round(km).toLocaleString('en-US') : km >= 10 ? km.toFixed(0) : km.toFixed(1));
  function fmtSep(m) {
    if (m >= 10e3) return `${fmtNum(m / 1000)}<small>km</small>`;
    if (m >= 1000) return `${(m / 1000).toFixed(1)}<small>km</small>`;
    return `${Math.round(m / 5) * 5}<small>m</small>`;
  }
  function perSecond(r) {
    if (r < 90) return `${Math.round(r)} sec`;
    if (r < 5400) return `${Math.round(r / 60)} min`;
    if (r < 129600) return `${(r / 3600).toFixed(r < 36000 ? 1 : 0)} hours`.replace(/^1\.0 hours$/, '1 hour');
    return `${(r / 86400).toFixed(1)} days`.replace('.0 days', ' days');
  }

  // Label placement memory (hysteresis).
  const memo = { tagX: null, tagC: null, lastS: -1 };

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------
  function update(s, t, b, st) {
    const sh = shotAt(s);
    const endA = fade(s, END, 99, 0.5);
    const live = 1 - endA;
    if (Math.abs(s - memo.lastS) > 0.2 || CUTS.some((c) => memo.lastS < c && s >= c)) {
      memo.tagX = null;
      memo.tagC = null;
    }
    memo.lastS = s;

    // Chapters
    for (const c of CHAPTERS) {
      const el = document.querySelector(`.ch[data-k="${c.key}"]`);
      const p = Math.min(1, Math.max(0, (s - c.s0) / (c.s1 - c.s0)));
      el.classList.toggle('on', s >= c.s0 && s < c.s1);
      el.querySelector('b').style.width = `${p * 100}%`;
    }
    $('#chapters').style.opacity = fade(s, CHAPTERS[0].s0 - 0.2, END, 0.4);

    // Caption
    let cur = null;
    let capA = 0;
    for (const c of CAPTIONS) {
      const a = fade(s, c.s0, c.s1, 0.3);
      if (a > capA) {
        cur = c;
        capA = a;
      }
    }
    if (cur) {
      capEl.classList.toggle('hook', !!cur.hook);
      capEl.querySelector('h1').innerHTML = cur.title;
      capEl.querySelector('p').innerHTML = cur.body;
    }
    capEl.style.opacity = capA * live;
    capEl.style.transform = `translateY(${(1 - capA) * 14 * U}px)`;

    // "22 days earlier" interstitial after the cold open
    const climbS = span('climb')[0];
    const inter = $('#interstitial');
    inter.style.opacity = fade(s, climbS - 0.05, climbS + 1.3, 0.25);

    // Clock, speed, mode, light
    const d = new Date(Date.parse(D.t0) + t * 1000);
    const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    $('#clock .date').textContent = `${mon} ${d.getUTCDate()}`;
    $('#clock .time').textContent = `${d.toISOString().slice(11, 16)} UTC`;
    $('#clock .rate').innerHTML = `1 sec = ${perSecond(rate(s))}`;
    $('#clock .ff').style.display = sh.mode === 'ff' ? 'inline-block' : 'none';
    const lit = st.lx > 0.5;
    const light = $('#clock .light');
    light.className = `light ${lit ? 'day' : 'night'}`;
    light.innerHTML = lit ? '<i></i>In sunlight' : '<i></i>In Earth\'s shadow';
    light.style.display = sh.mode === 'true' && sh.id !== 'climb' && sh.id !== 'end' ? 'inline-flex' : 'none';
    $('#clock').style.opacity = live;

    // Distance readout
    const ro = $('#readout');
    ro.style.opacity = fade(s, climbS + 0.6, END, 0.4);
    ro.querySelector('.val').innerHTML = fmtSep(st.sep);
    const [r, tt0] = st.rel;
    const circ = 2 * Math.PI * D.a_ref_km * 1000;
    const tt = ((tt0 % circ) + circ * 1.5) % circ - circ / 2;
    let ctxLine;
    if (st.sep < 1500) ctxLine = `≈ ${Math.max(1, Math.round(st.sep / 100))} football fields`;
    else if (st.sep < 2e6) ctxLine = `${Math.abs(tt) >= 1e4 ? fmtNum(Math.abs(tt) / 1000) + ' km' : (Math.abs(tt) / 1000).toFixed(1) + ' km'} ${tt < 0 ? 'behind' : 'ahead'}${Math.abs(r) > 20e3 ? ` · ${fmtNum(Math.abs(r) / 1000)} km ${r > 0 ? 'higher' : 'lower'}` : ''}`;
    else ctxLine = `${Math.abs(r) > 20e3 ? `${fmtNum(Math.abs(r) / 1000)} km higher · ` : ''}a quarter-orbit or more apart`;
    if (s > caS && s < span('leave')[0] + 0.5) ctxLine += ` · closest ${CA_M} m`;
    ro.querySelector('.ctx').textContent = ctxLine;
    const relLine = ro.querySelector('.rel');
    relLine.textContent = st.sep < 2e4 && sh.mode === 'true' ? (st.relSpeed < 0.2 ? `relative speed ${Math.round(st.relSpeed * 100)} cm/s` : `relative speed ${st.relSpeed.toFixed(1)} m/s`) : '';

    // Scale chip
    const magEl = $('#mag');
    const enlarged = st.mag > 1.5;
    const trueSize = !enlarged && st.camDistX < 200;
    magEl.style.opacity = (enlarged || trueSize) ? fade(s, climbS, END, 0.3) : 0;
    magEl.classList.toggle('enlarged', enlarged);
    magEl.textContent = enlarged ? `Satellites enlarged ${Math.round(st.mag)}×` : 'True size';

    // Timeline
    const px = timeline.x(Math.min(Math.max(t, TL.t0), TL.t1));
    document.getElementById('tlHead').setAttribute('cx', px);
    document.getElementById('tlDone').setAttribute('x2', px);
    for (const g of tlBox.querySelectorAll('.burn')) g.style.opacity = Number(g.dataset.t) <= t ? 1 : 0.35;
    tlBox.querySelector('.camk').style.opacity = t >= CA_T - 60 ? 1 : 0.4;
    $('#tlwrap').style.opacity = fade(s, climbS + 0.6, END, 0.4);

    // Event toasts (max two, newest first)
    let html = '';
    const quiet = sh.id === 'ca';
    const active = EVENTS.map((e) => ({ e, a: fade(s, e.s, e.s + (e.kind === 'ca' ? 3.0 : e.kind === 'vantor' ? 2.2 : 1.9), 0.2) }))
      .filter((x) => x.a > 0).slice(-2).reverse();
    for (const { e, a } of quiet ? [] : active) {
      html += `<div class="event ${e.kind}" style="opacity:${a * live}"><i></i><div><div class="t">${e.title}</div><div class="sub">${e.sub}</div></div></div>`;
    }
    evEl.innerHTML = html;

    // Satellite tags with speeds, dimension line, pulse
    const pX = project(st.x36W);
    const pC = project(st.cosW);
    const tX = tag('tagX', 'ICEYE-X36', 'c-x36');
    const tC = tag('tagC', 'COSMOS 2612', 'c-cos');
    const tagA = fade(s, span('climb')[0] + 0.6, END, 0.4);
    const onScreen = (p) => p && p.x > -40 && p.y > -40 && p.x < W + 40 && p.y < H + 40;
    const speedX = `${(st.vX / 1000).toFixed(2)} km/s`;
    const speedC = `${(st.vC / 1000).toFixed(2)} km/s`;
    tX.querySelector('.meta').textContent = pX?.hidden ? 'far side of Earth' : `U.S.-registered radar sat · ${speedX}`;
    tC.querySelector('.meta').textContent = pC?.hidden ? 'far side of Earth' : `Russian military · ${speedC}`;
    let svg = '';
    const M = 24 * U;
    const obstacles = [];
    for (const q of ['#logo', '#clock', '#caption', '#readout', '#tlwrap', '#chapters', '#mag']) {
      const el = $(q);
      if (Number(el.style.opacity || 1) > 0.05) obstacles.push(el.getBoundingClientRect());
    }
    for (const el of evEl.children) obstacles.push(el.getBoundingClientRect());
    const overlap = (r) => obstacles.reduce((acc, o) => acc + Math.max(0, Math.min(r.r, o.right + 8 * U) - Math.max(r.l, o.left - 8 * U)) * Math.max(0, Math.min(r.b, o.bottom + 8 * U) - Math.max(r.t, o.top - 8 * U)), 0);

    // Dimension line + pill
    const dim = $('#dim');
    const gap = onScreen(pX) && onScreen(pC) ? Math.hypot(pC.x - pX.x, pC.y - pX.y) : 0;
    const dimA = st.sep < 60e3 && gap > 160 * U ? tagA : 0;
    if (dimA > 0) {
      svg += `<line x1="${pX.x}" y1="${pX.y}" x2="${pC.x}" y2="${pC.y}" stroke="#fff" stroke-opacity="${0.75 * dimA}" stroke-width="${2.5 * U}" stroke-dasharray="${10 * U} ${8 * U}"/>`;
      const nx = -(pC.y - pX.y) / gap;
      const ny = (pC.x - pX.x) / gap;
      const side = ny > 0 ? -1 : 1;
      dim.innerHTML = fmtSep(st.sep).replace(/<\/?small>/g, ' ').trim();
      const mx = (pX.x + pC.x) / 2 + side * nx * 40 * U;
      const my = (pX.y + pC.y) / 2 + side * ny * 40 * U;
      dim.style.left = `${mx}px`;
      dim.style.top = `${my}px`;
      const w = dim.offsetWidth;
      const h = dim.offsetHeight;
      obstacles.push({ left: mx - w / 2, right: mx + w / 2, top: my - h / 2, bottom: my + h / 2 });
    }
    dim.style.opacity = dimA;
    const k = (s - caS) / 1.2;
    if (k > 0 && k < 1) {
      for (const p of [pX, pC]) {
        if (!onScreen(p)) continue;
        svg += `<circle cx="${p.x}" cy="${p.y}" r="${(18 + 90 * k) * U}" fill="none" stroke="#fff" stroke-opacity="${(1 - k) * 0.9}" stroke-width="${4 * U}"/>`;
      }
    }

    // Tags: keep the previous quadrant unless it has been blocked for a while;
    // ease the label toward its target so it never jumps.
    const place = (key, el, p, prefer, color) => {
      if (!onScreen(p)) {
        el.style.opacity = 0;
        memo[key] = null;
        return;
      }
      el.style.opacity = tagA;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const rectFor = ([sx, sy]) => {
        const lx = p.x + sx * 66 * U;
        const ly = p.y + sy * 56 * U;
        const l = sx > 0 ? lx + 10 * U : lx - 10 * U - w;
        const r = { l, r: l + w, t: ly - h / 2, b: ly + h / 2 };
        const inside = r.l > M && r.r < W - M && r.t > M && r.b < H - M;
        return { sx, sy, lx, ly, r, cost: (inside ? 0 : 1e9) + overlap(r) };
      };
      const m = memo[key];
      let q = m ? [m.sx, m.sy] : prefer;
      let cand = rectFor(q);
      if (m) {
        m.blocked = cand.cost > 2000 * U * U ? m.blocked + 1 : 0;
      }
      if (!m || m.blocked > 8) {
        const quads = [q, prefer, [prefer[0], -prefer[1]], [-prefer[0], prefer[1]], [-prefer[0], -prefer[1]]];
        for (const qq of quads) {
          const c = rectFor(qq);
          if (c.cost < cand.cost - 1) cand = c;
        }
        q = [cand.sx, cand.sy];
      }
      // Ease: dx/dy offsets glide (state), anchor follows the satellite exactly.
      const target = { dx: cand.r.l - p.x, dy: cand.r.t - p.y };
      const prev = m && m.dx !== undefined ? m : null;
      const e = prev ? 0.3 : 1;
      const dx = prev ? prev.dx + (target.dx - prev.dx) * e : target.dx;
      const dy = prev ? prev.dy + (target.dy - prev.dy) * e : target.dy;
      memo[key] = { sx: q[0], sy: q[1], blocked: m && m.sx === q[0] && m.sy === q[1] ? m.blocked : 0, dx, dy };
      const left = Math.min(Math.max(p.x + dx, M), W - M - w);
      const top = Math.min(Math.max(p.y + dy, M), H - M - h);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.transform = 'none';
      el.style.textAlign = q[0] > 0 ? 'left' : 'right';
      obstacles.push({ left, right: left + w, top, bottom: top + h });
      const ax = q[0] > 0 ? left - 6 * U : left + w + 6 * U;
      const ay = top + h * 0.32;
      svg += `<line x1="${p.x + Math.sign(ax - p.x) * 14 * U}" y1="${p.y + Math.sign(ay - p.y) * 10 * U}" x2="${ax}" y2="${ay}" stroke="${color}" stroke-opacity="${tagA * 0.85}" stroke-width="${2.5 * U}"/>`;
      svg += `<circle cx="${p.x}" cy="${p.y}" r="${15 * U}" fill="none" stroke="${color}" stroke-opacity="${tagA * 0.9}" stroke-width="${2.5 * U}"/>`;
    };
    let pX0 = [1, -1];
    let pC0 = [-1, 1];
    if (onScreen(pX) && onScreen(pC)) {
      const sx = pC.x - pX.x >= 0 ? -1 : 1;
      const sy = pC.y - pX.y >= 0 ? -1 : 1;
      pX0 = [sx, sy];
      pC0 = [-sx, -sy];
    }
    place('tagX', tX, pX, pX0, '#5ce1e6');
    place('tagC', tC, pC, pC0, '#ff5a3c');
    leaders.innerHTML = svg;

    // Dip at cuts
    let dip = 0;
    for (const c of CUTS) dip = Math.max(dip, 1 - Math.abs(s - c) / 0.12);
    $('#dip').style.opacity = Math.max(0, dip);

    // End card
    const ec = $('#endcard');
    ec.style.opacity = endA;
    ec.style.background = `rgba(2,4,8,${0.8 * endA})`;
    if (!ec.dataset.built) {
      ec.dataset.built = '1';
      ec.innerHTML = `<div class="panel">
        <div class="big">~${CA_M} m</div>
        <div class="range">rebuilt from public element sets · LeoLabs ~500 m · published range 150–650 m</div>
        <div class="lead">Closest pass between Cosmos 2612 and ICEYE-X36 · Oct 18, in Earth's shadow</div>
        <div class="stats">
          <div><b>22</b><span>days in pursuit</span></div>
          <div><b>${BURNS.length}</b><span>engine burns</span></div>
          <div><b>${Math.max(1, Math.round((D.ca.v || 0.05) * 100))} cm/s</b><span>relative speed at closest pass</span></div>
        </div>
      </div>`;
    }
    $('#endlogo').style.opacity = endA;
    $('#logo').style.opacity = live;
    void DUR;
  }

  return { update };
}
