// "Seen from ICEYE-X36": a 2D inset in X36's rotating frame. X36 stays fixed
// at the top of its orbit ring; Cosmos 2612's path is drawn around it.
// Zoomed out it is the whole orbit (heights exaggerated, so "higher = slower,
// falls behind, laps" is visible); zoomed in it becomes a true-scale
// radial / along-track plot of the loops and the approach.

export function createInset({ D, U, relAt, canvas }) {
  const ctx = canvas.getContext('2d');
  const A = D.a_km; // km
  const AREF = D.a_ref_km;
  const RE = 6371;
  const state = { hw: null, lastS: -1 };
  const smooth = (x) => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  };

  function niceScale(km) {
    const p = 10 ** Math.floor(Math.log10(km));
    for (const m of [1, 2, 5, 10]) if (m * p >= km) return m * p;
    return 10 * p;
  }
  const fmt = (km) => (km >= 1 ? `${km.toLocaleString('en-US')} km` : `${Math.round(km * 1000)} m`);

  function draw(s, t, sepGuideKm, opts) {
    const W = canvas.width;
    const H = canvas.height;
    const dpr = W / canvas.clientWidth || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (opts.alpha <= 0.01) return;
    ctx.globalAlpha = opts.alpha;

    // Zoom: half-width (km) follows the guiding separation; eased frame to frame.
    const target = Math.min(9200, Math.max(1.0, 1.25 * sepGuideKm));
    if (state.hw === null || Math.abs(s - state.lastS) > 0.2 || opts.cut) state.hw = target;
    else state.hw = Math.exp(Math.log(state.hw) + (Math.log(target) - Math.log(state.hw)) * 0.12);
    state.lastS = s;
    const hw = state.hw;
    const wOut = smooth((hw - 150) / 2500); // 0 = close-up, 1 = whole-orbit view
    const exag = 1 + 19 * wOut; // radial exaggeration when zoomed out
    const wCenter = smooth((hw - 2500) / 5500);

    // Panel
    const pad = 18 * U * dpr;
    const r = 14 * U * dpr;
    ctx.fillStyle = 'rgba(5,9,16,0.78)';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, r);
    ctx.fill();
    ctx.stroke();
    const head = 52 * U * dpr;
    ctx.fillStyle = 'rgba(244,247,250,0.92)';
    ctx.font = `800 ${26 * U * dpr}px Inter, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('SEEN FROM X36', pad, head / 2 + 4 * dpr);
    const tw = ctx.measureText('SEEN FROM X36 ').width;
    ctx.fillStyle = '#ff5a3c';
    ctx.fillText('· red = Cosmos', pad + tw, head / 2 + 4 * dpr);
    ctx.fillStyle = 'rgba(244,247,250,0.6)';
    ctx.font = `700 ${24 * U * dpr}px Inter, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('flight →', W - pad, head / 2 + 4 * dpr);
    ctx.textAlign = 'left';

    // Plot area
    const px0 = pad;
    const py0 = head;
    const pw = W - 2 * pad;
    const ph = H - head - pad;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px0, py0, pw, ph);
    ctx.clip();
    const scale = pw / 2 / hw; // px per km
    // Centre: X36 when close; drifts toward Earth's centre when zoomed out.
    const cx = 0;
    const cy = A * (1 - wCenter) + 0 * wCenter;
    const ox = px0 + pw / 2;
    const oy = py0 + ph * (0.5 + 0.12 * (1 - wCenter));
    const P = (x, y) => [ox + (x - cx) * scale, oy - (y - cy) * scale];
    const ring = (rad) => {
      // Polyline of the visible part of a circle about Earth's centre.
      const pts = [];
      const span = Math.min(Math.PI, (hw * 1.6) / rad + 0.05);
      const n = 180;
      for (let k = 0; k <= n; k++) {
        const a = -span + (2 * span * k) / n;
        pts.push(P(rad * Math.sin(a), rad * Math.cos(a)));
      }
      return pts;
    };
    const path = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    };

    // Earth (exaggeration shrinks it so the altitude gap reads)
    const earthR = Math.max(A * 0.5, A - (A - RE) * exag); // schematic when heights are exaggerated
    if (earthR > 0) {
      const [ex, ey] = P(0, 0);
      const g = ctx.createRadialGradient(ex, ey - earthR * scale * 0.3, earthR * scale * 0.2, ex, ey, earthR * scale);
      g.addColorStop(0, '#1d3a5c');
      g.addColorStop(1, '#0b1a2c');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ex, ey, Math.max(0, earthR * scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,190,255,0.5)';
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }

    // X36's orbit
    ctx.setLineDash([8 * dpr, 7 * dpr]);
    ctx.strokeStyle = 'rgba(92,225,230,0.55)';
    ctx.lineWidth = 2 * dpr;
    path(ring(A));
    ctx.stroke();
    ctx.setLineDash([]);

    // Cosmos path (relative), with a fading tail
    const toXY = (rel) => {
      const phi = rel[1] / 1000 / AREF;
      const rad = A + (rel[0] / 1000) * exag;
      return [rad * Math.sin(phi), rad * Math.cos(phi)];
    };
    const spanH = opts.trailHours;
    const n = 260;
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const tt = t - spanH * 3600 + (k / n) * spanH * 3600;
      if (tt < 0) continue;
      const [x, y] = P(...toXY(relAt(tt)));
      if (prev) {
        ctx.strokeStyle = `rgba(255,90,60,${0.08 + 0.85 * (k / n) ** 1.5})`;
        ctx.lineWidth = (2.5 + 4 * (k / n)) * U * 2;
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      prev = [x, y];
    }
    const rel = relAt(t);
    const [cxp, cyp] = P(...toXY(rel));
    const [xxp, xyp] = P(0, A);
    // Gap line
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([5 * dpr, 6 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(xxp, xyp);
    ctx.lineTo(cxp, cyp);
    ctx.stroke();
    ctx.setLineDash([]);
    const dot = (x, y, col, rad) => {
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 14 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, rad * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    };
    dot(xxp, xyp, '#5ce1e6', 11 * U);
    dot(cxp, cyp, '#ff5a3c', 11 * U);
    ctx.font = `800 ${26 * U * dpr}px Inter, sans-serif`;
    ctx.fillStyle = '#5ce1e6';
    ctx.textAlign = 'center';
    ctx.fillText('X36', xxp, xyp - 24 * U * dpr);
    ctx.fillStyle = '#ff5a3c';
    const below = cyp > xyp + 10 * dpr || Math.abs(cxp - xxp) < 40 * U * dpr;
    ctx.fillText(opts.behindNote ? '← COSMOS falling behind' : 'COSMOS', Math.min(Math.max(cxp, px0 + 150 * U * dpr), px0 + pw - 150 * U * dpr), cyp + (below ? 32 : -24) * U * dpr);
    ctx.textAlign = 'left';
    ctx.restore();

    // Scale bar + exaggeration note
    const sb = niceScale(hw * 0.4);
    const sbpx = sb * scale;
    const by = H - pad * 0.55;
    ctx.strokeStyle = 'rgba(244,247,250,0.8)';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(pad, by);
    ctx.lineTo(pad + sbpx, by);
    ctx.stroke();
    ctx.fillStyle = 'rgba(244,247,250,0.85)';
    ctx.font = `700 ${24 * U * dpr}px 'JetBrains Mono', monospace`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmt(sb), pad, by - 6 * dpr);
    if (exag > 1.5) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,181,71,0.95)';
      ctx.font = `700 ${24 * U * dpr}px Inter, sans-serif`;
      ctx.fillText(`heights ×${Math.round(exag)}`, W - pad, by - 6 * dpr);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }

  return { draw };
}
