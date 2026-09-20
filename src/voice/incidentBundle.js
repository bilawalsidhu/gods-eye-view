/**
 * Incident replay bundles: one self-contained HTML file that freezes what the
 * console showed around a moment in time. It embeds the viewport screenshot,
 * a canvas map of every track near the incident, a scrubbable replay, the
 * fix timeline, the recent transcript and the alert text. Nothing in the
 * file references the network, so it can be mailed or archived as evidence.
 *
 * `buildIncidentBundle` is pure: hand it either a position-history object
 * (see src/history/positionHistory.js) or an already collected array of
 * tracks, and it returns the HTML string.
 */
export const DEFAULT_WINDOW_MS = 5 * 60_000;
export const DEFAULT_RADIUS_KM = 50;
/** Budgets that keep the bundle under ~400 KB before the screenshot. */
export const MAX_BUNDLE_TRACKS = 150;
export const MAX_BUNDLE_FIXES = 5000;
export const MAX_TIMELINE_ROWS = 600;
const KM_PER_DEG = 111.32;
const SAMPLE_STEP_MS = 20_000;

const finite = (value) => (Number.isFinite(value) ? value : null);
const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON that is safe inside a <script> element. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Keep at most `limit` fixes, always retaining the first and last. */
export function thinFixes(fixes, limit) {
  if (!Array.isArray(fixes) || fixes.length <= limit) return fixes || [];
  if (limit <= 1) return [fixes[fixes.length - 1]];
  const out = [];
  const step = (fixes.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) out.push(fixes[Math.round(i * step)]);
  return out;
}

function normalizeFix(fix) {
  if (!fix) return null;
  const t = Number(fix.t);
  const lat = Number(fix.lat);
  const lon = Number(fix.lon);
  if (![t, lat, lon].every(Number.isFinite)) return null;
  return {
    t,
    lat,
    lon,
    heightM: finite(Number(fix.heightM)),
    headingDeg: finite(Number(fix.headingDeg)),
    speed: finite(Number(fix.speed)),
  };
}

/**
 * Collect the tracks that passed within `radiusKm` of `center` during
 * [at - windowMs, at + windowMs]. Accepts a position-history object exposing
 * `entitiesAt`, `trackOf` and `range`, or a plain array of
 * { layerId, id, label, fixes } tracks which is filtered the same way.
 */
export function collectIncidentTracks(
  history,
  {
    at = Date.now(),
    windowMs = DEFAULT_WINDOW_MS,
    center = null,
    radiusKm = DEFAULT_RADIUS_KM,
    maxTracks = MAX_BUNDLE_TRACKS,
    maxFixes = MAX_BUNDLE_FIXES,
  } = {},
) {
  const from = at - windowMs;
  const to = at + windowMs;
  const hasCenter =
    center && Number.isFinite(center.lat) && Number.isFinite(center.lon);
  const candidates = [];
  if (Array.isArray(history)) {
    for (const track of history)
      candidates.push({
        layerId: String(track?.layerId ?? ''),
        id: String(track?.id ?? ''),
        label: String(track?.label ?? track?.id ?? ''),
        fixes: Array.isArray(track?.fixes) ? track.fixes : [],
      });
  } else if (history && typeof history.entitiesAt === 'function') {
    const seen = new Set();
    const range = typeof history.range === 'function' ? history.range() : {};
    const start = Number.isFinite(range.oldestT)
      ? Math.max(from, range.oldestT)
      : from;
    const end = Number.isFinite(range.newestT)
      ? Math.min(to, range.newestT)
      : to;
    const step = Math.max(1000, Math.min(SAMPLE_STEP_MS, (end - start) / 40));
    for (let t = start; t <= end + step; t += step) {
      for (const entity of history.entitiesAt(Math.min(t, end))) {
        const key = `${entity.layerId}|${entity.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          layerId: entity.layerId,
          id: entity.id,
          label: entity.label || entity.id,
          fixes: history.trackOf(entity.layerId, entity.id),
        });
      }
    }
  }

  const tracks = [];
  for (const candidate of candidates) {
    const fixes = [];
    for (const raw of candidate.fixes) {
      const fix = normalizeFix(raw);
      if (fix && fix.t >= from && fix.t <= to) fixes.push(fix);
    }
    if (!fixes.length) continue;
    fixes.sort((a, b) => a.t - b.t);
    let minKm = Infinity;
    if (hasCenter)
      for (const fix of fixes)
        minKm = Math.min(
          minKm,
          haversineKm(center.lat, center.lon, fix.lat, fix.lon),
        );
    else minKm = 0;
    if (minKm > radiusKm) continue;
    tracks.push({
      layerId: candidate.layerId,
      id: candidate.id,
      label: candidate.label,
      fixes,
      minKm,
    });
  }
  tracks.sort((a, b) => a.minKm - b.minKm || a.label.localeCompare(b.label));
  const kept = tracks.slice(0, maxTracks);
  const total = kept.reduce((sum, track) => sum + track.fixes.length, 0);
  if (total > maxFixes) {
    const ratio = maxFixes / total;
    for (const track of kept)
      track.fixes = thinFixes(
        track.fixes,
        Math.max(2, Math.floor(track.fixes.length * ratio)),
      );
  }
  return kept;
}

function compactTracks(tracks, t0) {
  return tracks.map((track) => ({
    layer: track.layerId,
    id: track.id,
    label: track.label,
    km: round(track.minKm, 1),
    fixes: track.fixes.map((fix) => [
      Math.round(fix.t - t0),
      round(fix.lat, 5),
      round(fix.lon, 5),
      round(fix.heightM, 0),
      Number.isFinite(fix.headingDeg)
        ? Math.round(((fix.headingDeg % 360) + 360) % 360) % 360
        : null,
      round(fix.speed, 1),
    ]),
  }));
}

const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : '');
const clock = (t) => (Number.isFinite(t) ? iso(t).slice(11, 19) : '');

function transcriptHtml(transcript, from, to) {
  const items = (Array.isArray(transcript) ? transcript : [])
    .filter((entry) => entry && String(entry.text || '').trim())
    .filter((entry) => {
      const at = Number(entry.at);
      return !Number.isFinite(at) || (at >= from && at <= to);
    })
    .slice(-40);
  if (!items.length)
    return '<p class="muted">No transcript in this window.</p>';
  return `<ol class="transcript">${items
    .map(
      (entry) =>
        `<li><span class="when">${escapeHtml(clock(Number(entry.at)))}</span> <b>${escapeHtml(entry.role || 'note')}</b> ${escapeHtml(entry.text)}</li>`,
    )
    .join('')}</ol>`;
}

function alertsHtml(alerts) {
  const list = (Array.isArray(alerts) ? alerts : alerts ? [alerts] : [])
    .map((alert) =>
      typeof alert === 'string'
        ? alert
        : [
            alert?.description || alert?.text || alert?.message,
            alert?.layer ? `(${alert.layer})` : '',
            alert?.scope ? `scope ${alert.scope}` : '',
          ]
            .filter(Boolean)
            .join(' '),
    )
    .filter((text) => text.trim());
  if (!list.length) return '<p class="muted">No alerts recorded.</p>';
  return `<ul class="alerts">${list.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`;
}

function tracksHtml(tracks, t0) {
  if (!tracks.length)
    return '<p class="muted">No tracks inside the radius during this window.</p>';
  const rows = tracks
    .map((track) => {
      const first = track.fixes[0];
      const last = track.fixes[track.fixes.length - 1];
      return `<tr><td>${escapeHtml(track.label)}</td><td>${escapeHtml(track.layerId)}</td><td>${escapeHtml(track.id)}</td><td>${track.fixes.length}</td><td>${escapeHtml(clock(first.t))}–${escapeHtml(clock(last.t))}</td><td>${round(track.minKm, 1) ?? ''}</td></tr>`;
    })
    .join('');
  return `<table class="grid"><thead><tr><th>Label</th><th>Layer</th><th>Id</th><th>Fixes</th><th>Seen (UTC)</th><th>Closest km</th></tr></thead><tbody>${rows}</tbody></table><p class="muted">Times are relative to ${escapeHtml(iso(t0))}.</p>`;
}

/**
 * Build the self-contained incident HTML.
 * @param {object} options
 * @param {string} [options.title]
 * @param {number} [options.at] Incident time in ms.
 * @param {number} [options.windowMs] Half-window around `at`.
 * @param {{lat:number, lon:number}} options.center
 * @param {number} [options.radiusKm]
 * @param {object|Array} options.history Position history or track array.
 * @param {string|null} [options.screenshotDataUrl]
 * @param {Array<{at:number, role:string, text:string}>} [options.transcript]
 * @param {Array|string} [options.alerts]
 * @param {string} [options.notes]
 * @param {object} [options.camera] Camera state for the header.
 */
export function buildIncidentBundle({
  title = 'Incident',
  at = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  center = null,
  radiusKm = DEFAULT_RADIUS_KM,
  history = [],
  screenshotDataUrl = null,
  transcript = [],
  alerts = [],
  notes = '',
  camera = null,
} = {}) {
  const tracks = collectIncidentTracks(history, {
    at,
    windowMs,
    center,
    radiusKm,
  });
  const from = at - windowMs;
  const to = at + windowMs;
  const hasCenter =
    center && Number.isFinite(center.lat) && Number.isFinite(center.lon);
  const resolvedCenter = hasCenter
    ? { lat: center.lat, lon: center.lon }
    : tracks.length
      ? {
          lat: tracks[0].fixes[tracks[0].fixes.length - 1].lat,
          lon: tracks[0].fixes[tracks[0].fixes.length - 1].lon,
        }
      : { lat: 0, lon: 0 };
  const fixCount = tracks.reduce((sum, track) => sum + track.fixes.length, 0);
  const data = {
    title: String(title),
    at,
    from,
    to,
    center: resolvedCenter,
    radiusKm,
    tracks: compactTracks(tracks, from),
    maxRows: MAX_TIMELINE_ROWS,
  };
  const safeTitle = escapeHtml(title);
  const screenshot =
    typeof screenshotDataUrl === 'string' &&
    screenshotDataUrl.startsWith('data:image/')
      ? `<figure class="shot"><img alt="Viewport at ${escapeHtml(iso(at))}" src="${screenshotDataUrl}"><figcaption>Viewport screenshot at export time.</figcaption></figure>`
      : '<p class="muted">No screenshot captured.</p>';
  const cameraLine = camera
    ? `Camera alt ${Math.round(Number(camera.alt) || 0)} m, heading ${Math.round(Number(camera.heading) || 0)}°, pitch ${Math.round(Number(camera.pitch) || 0)}°`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${safeTitle} — incident replay</title>
<style>
:root{color-scheme:dark;--bg:#0b0f14;--panel:#121820;--ink:#e6edf3;--muted:#8b98a5;--line:#243040;--accent:#5ac8fa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;padding:0 16px 48px}
header{padding:24px 0 12px;border-bottom:1px solid var(--line)}
h1{margin:0 0 6px;font-size:22px}
h2{font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px}
.meta{color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 18px;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.shot img{max-width:100%;border:1px solid var(--line);border-radius:6px;display:block}
figure{margin:0}
figcaption{color:var(--muted);font-size:12px;margin-top:6px}
.mapwrap{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto}
canvas{display:block;max-width:100%;background:#070a0e;border-radius:4px}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px;font-variant-numeric:tabular-nums}
.controls input[type=range]{flex:1 1 240px;min-width:160px}
button,select{background:#1b2431;color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:5px 10px;font:inherit;cursor:pointer}
button:hover{border-color:var(--accent)}
.grid{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px}
.grid th,.grid td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}
.grid th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--bg)}
.tablewrap{overflow-x:auto;max-height:420px;overflow-y:auto;border:1px solid var(--line);border-radius:6px}
.transcript{padding-left:18px}
.transcript li{margin:3px 0}
.when{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:4px}
.alerts li{margin:3px 0}
pre.notes{white-space:pre-wrap;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px}
footer{margin-top:36px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:10px}
</style>
</head>
<body>
<header>
<h1>${safeTitle}</h1>
<div class="meta">
<span>Incident time ${escapeHtml(iso(at))}</span>
<span>Window ±${Math.round(windowMs / 60_000)} min (${escapeHtml(clock(from))}–${escapeHtml(clock(to))} UTC)</span>
<span>Center ${round(resolvedCenter.lat, 4)}, ${round(resolvedCenter.lon, 4)}</span>
<span>Radius ${radiusKm} km</span>
<span>${tracks.length} track${tracks.length === 1 ? '' : 's'}, ${fixCount} fixes</span>
${cameraLine ? `<span>${escapeHtml(cameraLine)}</span>` : ''}
</div>
</header>

<h2>Screenshot</h2>
${screenshot}

<h2>Track map</h2>
<div class="mapwrap">
<canvas id="map" width="960" height="640" aria-label="Track map"></canvas>
<div class="controls">
<button id="play" type="button">Play</button>
<select id="rate" aria-label="Replay speed"><option value="1">×1</option><option value="10" selected>×10</option><option value="60">×60</option></select>
<input id="scrub" type="range" min="0" max="1000" value="1000" step="1" aria-label="Replay time">
<span id="clock" class="muted"></span>
</div>
<p class="muted">Older segments are blue, newer are red. Drag the slider to replay; markers show interpolated positions between fixes.</p>
</div>

<h2>Tracks</h2>
${tracksHtml(tracks, from)}

<h2>Fix timeline</h2>
<div class="tablewrap"><table class="grid" id="timeline"><thead><tr><th>Time (UTC)</th><th>Layer</th><th>Label</th><th>Lat</th><th>Lon</th><th>Alt m</th><th>Hdg</th><th>Speed m/s</th></tr></thead><tbody><tr><td colspan="8" class="muted">Enable scripting to render the timeline.</td></tr></tbody></table></div>
<p id="timeline-note" class="muted"></p>

<h2>Transcript</h2>
${transcriptHtml(transcript, from - windowMs, to + windowMs)}

<h2>Alerts</h2>
${alertsHtml(alerts)}

${notes ? `<h2>Notes</h2><pre class="notes">${escapeHtml(notes)}</pre>` : ''}

<footer>God's Eye View incident replay bundle. Self-contained: this file makes no network requests.</footer>

<script id="incident-data" type="application/json">${scriptJson(data)}</script>
<script>
(function(){
var data=JSON.parse(document.getElementById('incident-data').textContent);
var canvas=document.getElementById('map');
var ctx=canvas.getContext('2d');
var W=canvas.width,H=canvas.height;
var span=Math.max(1,data.to-data.from);
var cosLat=Math.cos(data.center.lat*Math.PI/180)||1e-6;
var pxPerKm=Math.min(W,H)/2/Math.max(1,data.radiusKm*1.15);
function wrap(d){return ((d+540)%360+360)%360-180}
function xy(lat,lon){return [W/2+wrap(lon-data.center.lon)*cosLat*${KM_PER_DEG}*pxPerKm,H/2-(lat-data.center.lat)*${KM_PER_DEG}*pxPerKm]}
function color(dt,a){var f=Math.max(0,Math.min(1,dt/span));return 'hsla('+Math.round(220-220*f)+',90%,60%,'+(a==null?1:a)+')'}
function fmt(t){return new Date(data.from+t).toISOString().slice(11,19)}
function lerpLon(a,b,f){return a+wrap(b-a)*f}
function posAt(fixes,dt){
  if(!fixes.length)return null;
  if(dt<fixes[0][0])return null;
  var last=fixes[fixes.length-1];
  if(dt>=last[0])return {lat:last[1],lon:last[2],hdg:last[4],alt:last[3],spd:last[5],ended:dt-last[0]};
  var lo=0,hi=fixes.length-1;
  while(hi-lo>1){var mid=(lo+hi)>>1;if(fixes[mid][0]<=dt)lo=mid;else hi=mid}
  var a=fixes[lo],b=fixes[hi],f=(b[0]-a[0])>0?(dt-a[0])/(b[0]-a[0]):1;
  return {lat:a[1]+(b[1]-a[1])*f,lon:lerpLon(a[2],b[2],f),hdg:b[4]==null?a[4]:b[4],alt:a[3],spd:a[5],ended:0};
}
function drawFrame(){
  ctx.clearRect(0,0,W,H);
  ctx.strokeStyle='#1c2634';ctx.lineWidth=1;
  var step=pxPerKm*niceKm(pxPerKm);
  for(var gx=W/2%step;gx<W;gx+=step){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,H);ctx.stroke()}
  for(var gy=H/2%step;gy<H;gy+=step){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke()}
  ctx.setLineDash([6,6]);ctx.strokeStyle='#3a4a5e';ctx.beginPath();ctx.arc(W/2,H/2,data.radiusKm*pxPerKm,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#8b98a5';ctx.font='12px system-ui,sans-serif';
  ctx.beginPath();ctx.moveTo(W/2-6,H/2);ctx.lineTo(W/2+6,H/2);ctx.moveTo(W/2,H/2-6);ctx.lineTo(W/2,H/2+6);ctx.strokeStyle='#8b98a5';ctx.stroke();
  ctx.fillText('center',W/2+8,H/2-6);
}
function niceKm(ppk){var target=W/5/ppk,steps=[0.5,1,2,5,10,20,50,100,200,500,1000],best=steps[0];for(var i=0;i<steps.length;i++)if(steps[i]<=target)best=steps[i];return best}
function drawScale(){
  var km=niceKm(pxPerKm),len=km*pxPerKm,x=16,y=H-20;
  ctx.strokeStyle='#e6edf3';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+len,y);ctx.moveTo(x,y-5);ctx.lineTo(x,y+5);ctx.moveTo(x+len,y-5);ctx.lineTo(x+len,y+5);ctx.stroke();
  ctx.fillStyle='#e6edf3';ctx.font='12px system-ui,sans-serif';ctx.fillText(km+' km',x+len+8,y+4);
  var nx=W-28,ny=36;ctx.beginPath();ctx.moveTo(nx,ny-18);ctx.lineTo(nx-7,ny+8);ctx.lineTo(nx,ny+2);ctx.lineTo(nx+7,ny+8);ctx.closePath();ctx.fillStyle='#e6edf3';ctx.fill();ctx.fillText('N',nx-4,ny+22);
}
function drawTrack(track,upTo,alpha){
  var f=track.fixes;if(f.length<1)return;
  ctx.lineWidth=alpha<1?1:2;
  for(var i=1;i<f.length;i++){
    if(f[i][0]>upTo)break;
    var a=xy(f[i-1][1],f[i-1][2]),b=xy(f[i][1],f[i][2]);
    ctx.strokeStyle=color(f[i][0],alpha);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();
  }
  var p=posAt(f,upTo);if(!p)return;
  var q=xy(p.lat,p.lon);
  ctx.fillStyle=color(Math.min(upTo,f[f.length-1][0]),alpha);ctx.beginPath();ctx.arc(q[0],q[1],alpha<1?2:4,0,Math.PI*2);ctx.fill();
  if(alpha<1)return;
  if(p.hdg!=null){var r=p.hdg*Math.PI/180;ctx.strokeStyle='#e6edf3';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(q[0],q[1]);ctx.lineTo(q[0]+Math.sin(r)*12,q[1]-Math.cos(r)*12);ctx.stroke()}
  ctx.fillStyle='#e6edf3';ctx.font='11px system-ui,sans-serif';ctx.fillText(track.label,q[0]+7,q[1]-6);
}
var scrub=document.getElementById('scrub'),clockEl=document.getElementById('clock'),play=document.getElementById('play'),rate=document.getElementById('rate');
function render(){
  var dt=span*scrub.value/1000;
  drawFrame();
  for(var i=0;i<data.tracks.length;i++)drawTrack(data.tracks[i],span,0.22);
  for(var j=0;j<data.tracks.length;j++)drawTrack(data.tracks[j],dt,1);
  drawScale();
  clockEl.textContent=fmt(dt)+' UTC ('+(dt<=span/2?'−':'+')+Math.round(Math.abs(dt-span/2)/1000)+' s)';
}
var playing=false,lastTick=0;
function tick(now){
  if(!playing)return;
  var elapsed=lastTick?now-lastTick:0;lastTick=now;
  var v=Number(scrub.value)+elapsed*Number(rate.value)/span*1000;
  if(v>=1000){v=1000;playing=false;play.textContent='Play'}
  scrub.value=v;render();
  if(playing)requestAnimationFrame(tick);
}
play.addEventListener('click',function(){
  playing=!playing;play.textContent=playing?'Pause':'Play';
  if(playing){if(Number(scrub.value)>=1000)scrub.value=0;lastTick=0;requestAnimationFrame(tick)}
});
scrub.addEventListener('input',function(){playing=false;play.textContent='Play';render()});
render();
var rows=[];
data.tracks.forEach(function(t){t.fixes.forEach(function(f){rows.push([f[0],t.layer,t.label,f[1],f[2],f[3],f[4],f[5]])})});
rows.sort(function(a,b){return a[0]-b[0]});
var shown=rows.length>data.maxRows?rows.filter(function(_,i){return i%Math.ceil(rows.length/data.maxRows)===0}):rows;
var body=document.querySelector('#timeline tbody');body.textContent='';
shown.forEach(function(r){var tr=document.createElement('tr');[fmt(r[0]),r[1],r[2],r[3],r[4],r[5]==null?'':r[5],r[6]==null?'':r[6],r[7]==null?'':r[7]].forEach(function(c){var td=document.createElement('td');td.textContent=String(c);tr.appendChild(td)});body.appendChild(tr)});
document.getElementById('timeline-note').textContent=shown.length<rows.length?'Showing '+shown.length+' of '+rows.length+' fixes (evenly sampled).':rows.length+' fixes.';
})();
</script>
</body>
</html>
`;
}

/** Byte length of a bundle, for size reporting. */
export function bundleBytes(html) {
  return new TextEncoder().encode(html).length;
}

/** File-name safe slug for a title. */
export function incidentSlug(title, fallback = 'incident') {
  const slug = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || fallback;
}
