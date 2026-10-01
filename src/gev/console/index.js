import { api } from './api.js';
import { createOpsGlobe } from './globe.js';
import {
  interpolateTrack,
  viewBbox,
  bboxParam,
  utcClock,
  utcDate,
  ago,
  slugId,
  parseEntries,
  formatEntry,
  ruleFromForm,
  RULE_FIELDS,
  fenceFromClicks,
  sparklinePath,
  esc,
} from './model.js';
import { injectOpsStyles } from './styles.js';

/**
 * Ops console: alerts, watchlists/fences/rules, time-machine replay, track
 * history and camera coverage/health, mounted beside the existing app.
 *
 * It owns its DOM, its globe drawings, its timers and its SSE stream, and
 * releases all of them in destroy(). Toggle with the OPS chip or the `
 * (backtick) key.
 */

const TABS = ['alerts', 'watch', 'replay', 'history', 'cameras'];
const RULE_LABELS = {
  'fence-enter': 'Enters fence',
  'fence-exit': 'Leaves fence',
  'fence-dwell': 'Stays in fence',
  squawk: 'Emergency squawk',
  dark: 'Goes dark',
  appear: 'Reappears',
  speed: 'Speed outside band',
  altitude: 'Altitude outside band',
  loiter: 'Circling / loitering',
  overhead: 'Satellite overhead',
};
const FIELD_LABELS = {
  fenceId: 'Fence',
  watchlistId: 'Only watchlist',
  domain: 'Only domain',
  minutes: 'Minutes',
  codes: 'Codes (blank = 7500 7600 7700)',
  min: 'Min',
  max: 'Max',
  radiusKm: 'Radius km',
  minElevDeg: 'Min elevation °',
  leadMinutes: 'Warn minutes ahead',
};

export function mountOpsConsole({ viewer, documentRef = document }) {
  injectOpsStyles(documentRef);
  const globe = createOpsGlobe(viewer);
  const root = documentRef.createElement('div');
  root.className = 'gev-ops';
  root.innerHTML = `
    <button type="button" class="gev-ops-chip" aria-expanded="false" title="Ops console (\`)">
      <span>OPS CONSOLE</span><span class="gev-ops-badge" hidden>0</span>
    </button>
    <section class="gev-ops-panel" hidden aria-label="Ops console">
      <header>
        <nav role="tablist">${TABS.map((t) => `<button type="button" role="tab" data-tab="${t}">${t}</button>`).join('')}</nav>
        <button type="button" class="gev-ops-close" aria-label="Close ops console">×</button>
      </header>
      <div class="gev-ops-body">${TABS.map((t) => `<div class="gev-ops-tab" data-pane="${t}" hidden></div>`).join('')}</div>
      <footer><span class="gev-ops-status">connecting…</span></footer>
    </section>
    <div class="gev-ops-toasts" aria-live="polite"></div>
    <div class="gev-ops-replay-banner" hidden></div>`;
  documentRef.body.appendChild(root);

  const $ = (sel, el = root) => el.querySelector(sel);
  const chip = $('.gev-ops-chip');
  const panel = $('.gev-ops-panel');
  const badge = $('.gev-ops-badge');
  const statusEl = $('.gev-ops-status');
  const toasts = $('.gev-ops-toasts');
  const banner = $('.gev-ops-replay-banner');
  const pane = (t) => $(`[data-pane="${t}"]`);

  const state = {
    tab: 'alerts',
    watch: { watchlists: [], fences: [], rules: [], channels: [] },
    alerts: [],
    replay: {
      active: false,
      t: Date.now() - 3_600_000,
      playing: false,
      speed: 60,
      data: null,
      loading: false,
      oldest: null,
    },
    history: { assets: [], selected: null, window: '6h' },
    notify: false,
    destroyed: false,
  };
  const timers = [];
  let stream = null;

  // ------------------------------------------------------------ chrome
  const open = (on) => {
    panel.hidden = !on;
    chip.setAttribute('aria-expanded', String(on));
    if (on) renderTab();
  };
  chip.addEventListener('click', () => open(panel.hidden));
  $('.gev-ops-close').addEventListener('click', () => open(false));
  $('nav').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]')?.dataset.tab;
    if (t) {
      state.tab = t;
      renderTab();
    }
  });
  const onKey = (e) => {
    if (e.key !== '`' || e.target?.matches?.('input, textarea, select')) return;
    open(panel.hidden);
  };
  documentRef.addEventListener('keydown', onKey);

  function toast(text, severity = 'info', action) {
    const el = documentRef.createElement('div');
    el.className = `gev-ops-toast sev-${severity}`;
    el.innerHTML = `<span>${esc(text)}</span>`;
    if (action) {
      const b = documentRef.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        action.run();
        el.remove();
      });
      el.appendChild(b);
    }
    toasts.prepend(el);
    while (toasts.children.length > 4) toasts.lastChild.remove();
    setTimeout(() => el.remove(), severity === 'critical' ? 20000 : 8000);
  }

  const fail = (error) => toast(error?.message || String(error), 'warning');

  function renderTab() {
    for (const b of root.querySelectorAll('[data-tab]'))
      b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
    for (const t of TABS) pane(t).hidden = t !== state.tab;
    ({
      alerts: renderAlerts,
      watch: renderWatch,
      replay: renderReplay,
      history: renderHistory,
      cameras: renderCameras,
    })[state.tab]();
  }

  // ------------------------------------------------------------ alerts
  function unacked() {
    return state.alerts.filter((a) => !a.acked).length;
  }
  function updateBadge() {
    const n = unacked();
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }

  function renderAlerts() {
    const el = pane('alerts');
    const now = Date.now();
    el.innerHTML = `
      <div class="gev-row">
        <button type="button" data-act="notify">${state.notify ? 'Desktop alerts on' : 'Enable desktop alerts'}</button>
        <button type="button" data-act="ackall" ${unacked() ? '' : 'disabled'}>Acknowledge all</button>
      </div>
      ${state.alerts.length ? '' : '<p class="gev-empty">No alerts in the last 24 hours. Add rules under Watch.</p>'}
      <ul class="gev-list">${state.alerts
        .slice(0, 150)
        .map(
          (
            a,
          ) => `<li class="sev-${esc(a.severity)} ${a.acked ? 'acked' : ''}" data-id="${esc(a.id)}">
            <div class="gev-title">${esc(a.title)}</div>
            <div class="gev-meta">${esc(a.kind)} · ${utcClock(a.t)} · ${ago(a.t, now)}</div>
            <div class="gev-actions">
              ${Number.isFinite(a.lat) ? '<button type="button" data-act="fly">Fly</button>' : ''}
              ${a.domain === 'air' || a.domain === 'sea' ? '<button type="button" data-act="track">Track</button>' : ''}
              ${a.acked ? '' : '<button type="button" data-act="ack">Ack</button>'}
            </div></li>`,
        )
        .join('')}</ul>`;
    el.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'notify') return enableNotifications();
      if (act === 'ackall') {
        for (const a of state.alerts.filter((x) => !x.acked)) {
          await api.ack(a.id).catch(() => {});
          a.acked = true;
        }
        updateBadge();
        return renderAlerts();
      }
      const id = e.target.closest('[data-id]')?.dataset.id;
      const a = state.alerts.find((x) => x.id === id);
      if (!a) return;
      if (act === 'fly')
        globe.flyTo(a.lat, a.lon, a.domain === 'air' ? 25000 : 8000);
      if (act === 'track')
        showTrack(a.domain, a.asset, a.label || a.detail?.label, {
          to: a.t + 15 * 60_000,
          from: a.t - 2 * 3_600_000,
        });
      if (act === 'ack') {
        await api.ack(a.id).catch(fail);
        a.acked = true;
        updateBadge();
        renderAlerts();
      }
    };
  }

  async function enableNotifications() {
    if (!('Notification' in window))
      return toast('This browser has no desktop notifications', 'warning');
    const p = await Notification.requestPermission();
    state.notify = p === 'granted';
    if (!state.notify) toast('Desktop alerts were not allowed', 'warning');
    renderAlerts();
  }

  function onAlert(a) {
    if (state.alerts.some((x) => x.id === a.id)) return;
    state.alerts.unshift(a);
    state.alerts.length = Math.min(state.alerts.length, 500);
    updateBadge();
    toast(
      a.title,
      a.severity,
      Number.isFinite(a.lat)
        ? {
            label: 'Fly',
            run: () =>
              globe.flyTo(a.lat, a.lon, a.domain === 'air' ? 25000 : 8000),
          }
        : undefined,
    );
    if (state.notify && documentRef.hidden) {
      try {
        new Notification(`God's Eye View · ${a.severity}`, {
          body: a.title,
          tag: a.id,
        });
      } catch {
        // notification rejected by the platform
      }
    }
    if (!panel.hidden && state.tab === 'alerts') renderAlerts();
  }

  function connectStream() {
    if (state.destroyed || typeof EventSource === 'undefined') return;
    stream = new EventSource('/api/watch/stream');
    stream.addEventListener('alert', (e) => {
      try {
        onAlert(JSON.parse(e.data));
      } catch {
        // malformed frame
      }
    });
    stream.onerror = () => {
      // EventSource retries on its own; surface the state in the footer.
      statusEl.dataset.stream = 'retrying';
    };
    stream.addEventListener('hello', () => {
      statusEl.dataset.stream = 'live';
    });
  }

  // ------------------------------------------------------------ watch
  async function loadWatch() {
    state.watch = await api.watchState();
    globe.setFences(state.watch.fences);
  }

  const options = (list, selected, blank) =>
    `${blank ? `<option value="">${esc(blank)}</option>` : ''}${list
      .map(
        (x) =>
          `<option value="${esc(x.id)}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`,
      )
      .join('')}`;

  function renderWatch() {
    const w = state.watch;
    const el = pane('watch');
    el.innerHTML = `
      <details open><summary>Watchlists (${w.watchlists.length})</summary>
        <ul class="gev-list compact">${w.watchlists
          .map(
            (
              l,
            ) => `<li data-id="${esc(l.id)}"><div class="gev-title">${esc(l.name)}</div><div class="gev-meta">${l.entries.length} entries</div>
            <div class="gev-actions"><button type="button" data-act="edit-wl">Edit</button><button type="button" data-act="del-wl">Delete</button></div></li>`,
          )
          .join('')}</ul>
        <form data-form="wl" class="gev-form">
          <input name="id" type="hidden">
          <label>Name <input name="name" required maxlength="80" placeholder="e.g. Medevac helicopters"></label>
          <label>Entries, one per line
            <textarea name="entries" rows="4" placeholder="air a1b2c3&#10;air label:N911&#10;sea 366999999&#10;space 25544"></textarea></label>
          <div class="gev-row"><button type="submit">Save watchlist</button><button type="reset">Clear</button></div>
        </form>
      </details>
      <details><summary>Fences (${w.fences.length})</summary>
        <ul class="gev-list compact">${w.fences
          .map(
            (
              f,
            ) => `<li data-id="${esc(f.id)}"><div class="gev-title">${esc(f.name)}</div><div class="gev-meta">${f.shape.type === 'circle' ? `circle ${(f.shape.radiusM / 1000).toFixed(1)} km` : `${f.shape.coords.length}-point polygon`}</div>
            <div class="gev-actions"><button type="button" data-act="fly-fence">Fly</button><button type="button" data-act="del-fence">Delete</button></div></li>`,
          )
          .join('')}</ul>
        <div class="gev-form">
          <label>New fence name <input data-field="fence-name" maxlength="80" placeholder="e.g. Port of Oakland"></label>
          <div class="gev-row"><button type="button" data-act="draw-circle">Draw circle</button><button type="button" data-act="draw-poly">Draw polygon</button></div>
          <p class="gev-hint">Circle: click centre, then edge. Polygon: click points, right-click or Enter to finish. Esc cancels.</p>
        </div>
      </details>
      <details><summary>Rules (${w.rules.length})</summary>
        <ul class="gev-list compact">${w.rules
          .map(
            (
              r,
            ) => `<li data-id="${esc(r.id)}" class="sev-${esc(r.severity)} ${r.enabled === false ? 'acked' : ''}"><div class="gev-title">${esc(r.name)}</div><div class="gev-meta">${esc(RULE_LABELS[r.kind] || r.kind)}${r.channels?.length ? ' · webhook' : ''}</div>
            <div class="gev-actions"><button type="button" data-act="toggle-rule">${r.enabled === false ? 'Enable' : 'Pause'}</button><button type="button" data-act="del-rule">Delete</button></div></li>`,
          )
          .join('')}</ul>
        <form data-form="rule" class="gev-form">
          <label>Name <input name="name" required maxlength="80"></label>
          <label>When <select name="kind">${Object.entries(RULE_LABELS)
            .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
            .join('')}</select></label>
          <div data-fields></div>
          <label>Severity <select name="severity"><option>info</option><option>warning</option><option>critical</option></select></label>
          <label>Also send to <select name="channelId">${options(w.channels, '', 'No webhook')}</select></label>
          <div class="gev-row"><button type="submit">Add rule</button></div>
        </form>
      </details>
      <details><summary>Webhooks (${w.channels.length})</summary>
        <ul class="gev-list compact">${w.channels
          .map(
            (
              c,
            ) => `<li data-id="${esc(c.id)}"><div class="gev-title">${esc(c.name)}</div><div class="gev-meta">${esc(c.type)} · ${esc(c.url)}</div>
            <div class="gev-actions"><button type="button" data-act="test-ch">Test</button><button type="button" data-act="del-ch">Delete</button></div></li>`,
          )
          .join('')}</ul>
        <form data-form="channel" class="gev-form">
          <label>Name <input name="name" required maxlength="80"></label>
          <label>Type <select name="type"><option value="slack">Slack</option><option value="discord">Discord</option><option value="webhook">Other (operator-allowed host)</option></select></label>
          <label>Webhook URL <input name="url" type="url" required placeholder="https://hooks.slack.com/services/…"></label>
          <div class="gev-row"><button type="submit">Add webhook</button></div>
        </form>
      </details>`;

    const ruleForm = $('[data-form="rule"]', el);
    const fieldsEl = $('[data-fields]', ruleForm);
    const renderFields = () => {
      const kind = ruleForm.kind.value;
      fieldsEl.innerHTML = RULE_FIELDS[kind]
        .map((f) => {
          if (f === 'fenceId')
            return `<label>${FIELD_LABELS[f]} <select name="fenceId" required>${options(w.fences, '', w.fences.length ? null : 'Draw a fence first')}</select></label>`;
          if (f === 'watchlistId') {
            const required = ['dark', 'appear', 'overhead'].includes(kind);
            return `<label>${required ? 'Watchlist' : FIELD_LABELS[f]} <select name="watchlistId" ${required ? 'required' : ''}>${options(w.watchlists, '', required ? (w.watchlists.length ? null : 'Create a watchlist first') : 'Any asset')}</select></label>`;
          }
          if (f === 'domain')
            return `<label>${FIELD_LABELS[f]} <select name="domain"><option value="">Air and sea</option><option value="air">Air</option><option value="sea">Sea</option></select></label>`;
          if (f === 'codes')
            return `<label>${FIELD_LABELS[f]} <input name="codes" placeholder="7700"></label>`;
          const unit =
            f === 'min' || f === 'max'
              ? kind === 'altitude'
                ? ' (m)'
                : ' (air m/s, sea kn)'
              : '';
          return `<label>${FIELD_LABELS[f]}${unit} <input name="${f}" type="number" step="any"></label>`;
        })
        .join('');
    };
    ruleForm.kind.addEventListener('change', renderFields);
    renderFields();

    el.onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        if (form.dataset.form === 'wl') {
          const { entries, errors } = parseEntries(data.entries);
          if (errors.length)
            return toast(
              `Could not read: ${errors.slice(0, 3).join(', ')}`,
              'warning',
            );
          const id =
            data.id ||
            slugId(
              data.name,
              w.watchlists.map((x) => x.id),
            );
          await api.put('watchlists', id, { name: data.name, entries });
          toast(`Watchlist "${data.name}" saved`);
        }
        if (form.dataset.form === 'rule') {
          const id = slugId(
            data.name,
            w.rules.map((x) => x.id),
          );
          await api.put('rules', id, { ...ruleFromForm(data), enabled: true });
          toast(`Rule "${data.name}" added`);
        }
        if (form.dataset.form === 'channel') {
          const id = slugId(
            data.name,
            w.channels.map((x) => x.id),
          );
          await api.put('channels', id, data);
          toast(`Webhook "${data.name}" added`);
        }
        await loadWatch();
        renderWatch();
      } catch (error) {
        fail(error);
      }
    };

    el.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const id = e.target.closest('[data-id]')?.dataset.id;
      try {
        if (act === 'edit-wl') {
          const l = w.watchlists.find((x) => x.id === id);
          const f = $('[data-form="wl"]', el);
          f.id.value = l.id;
          f.name.value = l.name;
          f.entries.value = l.entries.map(formatEntry).join('\n');
          return;
        }
        if (act === 'draw-circle' || act === 'draw-poly') {
          const name = $('[data-field="fence-name"]', el).value.trim();
          if (!name) return toast('Name the fence first', 'warning');
          const mode = act === 'draw-circle' ? 'circle' : 'polygon';
          toast(
            mode === 'circle'
              ? 'Click the centre, then the edge'
              : 'Click points; right-click or Enter to finish',
          );
          const pts = await globe.draw(mode);
          if (!pts) return;
          const fence = fenceFromClicks(mode, pts, name);
          if (!fence) return toast('Not enough points', 'warning');
          await api.put(
            'fences',
            slugId(
              name,
              w.fences.map((x) => x.id),
            ),
            fence,
          );
          toast(`Fence "${name}" saved`);
        }
        if (act === 'fly-fence') {
          const f = w.fences.find((x) => x.id === id);
          const [lon, lat] =
            f.shape.type === 'circle' ? f.shape.center : f.shape.coords[0];
          return globe.flyTo(lat, lon, 20000);
        }
        if (act === 'toggle-rule') {
          const r = w.rules.find((x) => x.id === id);
          const { id: _id, owner: _o, updated: _u, ...body } = r;
          await api.put('rules', id, { ...body, enabled: r.enabled === false });
        }
        if (act === 'test-ch') {
          await api.testChannel(id);
          return toast('Test sent');
        }
        const del = {
          'del-wl': 'watchlists',
          'del-fence': 'fences',
          'del-rule': 'rules',
          'del-ch': 'channels',
        }[act];
        if (del) {
          try {
            await api.remove(del, id);
          } catch (error) {
            if (error.status === 409)
              return toast(
                `In use by: ${error.data.rules.join(', ')}`,
                'warning',
              );
            throw error;
          }
        }
        await loadWatch();
        renderWatch();
      } catch (error) {
        fail(error);
      }
    };
  }

  // ------------------------------------------------------------ replay
  const R = state.replay;
  const WINDOW_MS = 30 * 60_000;

  function renderReplay() {
    const el = pane('replay');
    const now = Date.now();
    const oldest = R.oldest ?? now - 48 * 3_600_000;
    el.innerHTML = `
      <p class="gev-hint">Replays recorded aircraft and vessels inside the current view. Live layers stay on; hide them under Layers to see only the replay.</p>
      <div class="gev-clock"><span data-out="date">${utcDate(R.t)}</span> <strong data-out="clock">${utcClock(R.t)}</strong></div>
      <input type="range" data-in="t" min="${oldest}" max="${now}" step="1000" value="${Math.min(Math.max(R.t, oldest), now)}" aria-label="Replay time">
      <div class="gev-row">
        <button type="button" data-act="play">${R.playing ? 'Pause' : 'Play'}</button>
        <select data-in="speed" aria-label="Replay speed">${[1, 10, 60, 300, 900].map((s) => `<option value="${s}" ${s === R.speed ? 'selected' : ''}>${s}×</option>`).join('')}</select>
        <button type="button" data-act="back">−15 min</button>
        <button type="button" data-act="fwd">+15 min</button>
        <button type="button" data-act="now">Last hour</button>
      </div>
      <div class="gev-row">
        <button type="button" data-act="${R.active ? 'stop' : 'start'}">${R.active ? 'Exit replay' : 'Start replay in this view'}</button>
      </div>
      <p class="gev-meta" data-out="info">${R.active ? replayInfo() : 'Not replaying.'}</p>`;
    const slider = $('[data-in="t"]', el);
    slider.addEventListener('input', () => {
      R.t = Number(slider.value);
      tickReplay(true);
    });
    $('[data-in="speed"]', el).addEventListener(
      'change',
      (e) => (R.speed = Number(e.target.value)),
    );
    el.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'play') R.playing = !R.playing;
      if (act === 'back') R.t -= 15 * 60_000;
      if (act === 'fwd') R.t = Math.min(Date.now(), R.t + 15 * 60_000);
      if (act === 'now') R.t = Date.now() - 3_600_000;
      if (act === 'start') {
        R.active = true;
        R.data = null;
      }
      if (act === 'stop') {
        R.active = false;
        R.playing = false;
        R.data = null;
        globe.setReplay([]);
        banner.hidden = true;
      }
      renderReplay();
      tickReplay(true);
    };
  }

  function replayInfo() {
    if (R.loading) return 'Loading…';
    if (!R.data) return 'Zoom to a region (under 30° across) to replay.';
    return `${R.data.tracks.length} tracks loaded for ${utcClock(R.data.from)}–${utcClock(R.data.to)}`;
  }

  async function ensureReplayData() {
    const bbox = viewBbox(globe.viewRect());
    if (!bbox) {
      R.data = null;
      return;
    }
    const key = bboxParam(bbox);
    if (
      R.data &&
      R.data.key === key &&
      R.t >= R.data.from + 60_000 &&
      R.t <= R.data.to - 60_000
    )
      return;
    if (R.loading) return;
    R.loading = true;
    try {
      const from = R.t - WINDOW_MS / 2;
      const to = Math.min(Date.now(), R.t + WINDOW_MS / 2);
      const data = await api.range({
        from: Math.round(from),
        to: Math.round(to),
        bbox: key,
        limit: 150000,
      });
      R.data = { ...data, key };
    } catch (error) {
      fail(error);
      R.data = null;
    } finally {
      R.loading = false;
    }
  }

  let lastFrame = performance.now();
  async function tickReplay(force = false) {
    const nowPerf = performance.now();
    const dt = nowPerf - lastFrame;
    lastFrame = nowPerf;
    if (!R.active) return;
    if (R.playing) {
      R.t += dt * R.speed;
      if (R.t >= Date.now()) {
        R.t = Date.now();
        R.playing = false;
      }
    }
    if (!R.playing && !force) return;
    await ensureReplayData();
    const heads = [];
    for (const tr of R.data?.tracks || []) {
      const f = interpolateTrack(tr.fixes, R.t);
      if (f)
        heads.push({
          key: `${tr.domain}:${tr.id}`,
          domain: tr.domain,
          lat: f.lat,
          lon: f.lon,
          alt: f.alt,
        });
    }
    globe.setReplay(heads);
    banner.hidden = false;
    banner.textContent = `REPLAY ${utcDate(R.t)} ${utcClock(R.t)} · ${heads.length} contacts${R.playing ? ` · ${R.speed}×` : ''}`;
    if (!panel.hidden && state.tab === 'replay') {
      const el = pane('replay');
      const clock = $('[data-out="clock"]', el);
      if (clock) {
        clock.textContent = utcClock(R.t);
        $('[data-out="date"]', el).textContent = utcDate(R.t);
        $('[data-in="t"]', el).value = String(R.t);
        $('[data-out="info"]', el).textContent = replayInfo();
        const play = el.querySelector('[data-act="play"]');
        if (play) play.textContent = R.playing ? 'Pause' : 'Play';
      }
    }
  }

  // ------------------------------------------------------------ history
  const H = state.history;
  const WINDOWS = {
    '1h': 3_600_000,
    '6h': 6 * 3_600_000,
    '24h': 86_400_000,
    '7d': 7 * 86_400_000,
    '30d': 30 * 86_400_000,
  };

  function renderHistory() {
    const el = pane('history');
    el.innerHTML = `
      <form data-form="search" class="gev-form gev-row">
        <input name="q" placeholder="Callsign, vessel name, ICAO hex or MMSI" value="${esc(H.q || '')}" aria-label="Search history">
        <button type="submit">Search</button>
      </form>
      <ul class="gev-list compact">${H.assets
        .map(
          (
            a,
          ) => `<li data-key="${esc(a.domain)}:${esc(a.id)}" class="${H.selected?.id === a.id ? 'selected' : ''}">
          <div class="gev-title">${esc(a.label || a.id)} <span class="gev-tag">${esc(a.domain)}</span></div>
          <div class="gev-meta">${esc(a.id)} · last seen ${ago(a.lastSeen, Date.now())}</div>
          <div class="gev-actions"><button type="button" data-act="show">Track</button></div></li>`,
        )
        .join('')}</ul>
      ${
        H.selected
          ? `<div class="gev-form">
        <label>Window <select data-in="window">${Object.keys(WINDOWS)
          .map(
            (k) => `<option ${k === H.window ? 'selected' : ''}>${k}</option>`,
          )
          .join('')}</select></label>
        <p class="gev-meta">${esc(H.selected.label || H.selected.id)}: ${H.count ?? 0} fixes</p>
        <div class="gev-row">${['geojson', 'csv', 'kml']
          .map(
            (f) =>
              `<a class="gev-btn" download href="${api.trackExportUrl({ domain: H.selected.domain, id: H.selected.id, from: `-${H.window}`, format: f, limit: 50000 })}">${f.toUpperCase()}</a>`,
          )
          .join(
            '',
          )}<button type="button" data-act="clear">Clear track</button></div></div>`
          : ''
      }`;
    el.onsubmit = async (e) => {
      e.preventDefault();
      H.q = new FormData(e.target).get('q');
      try {
        H.assets = (await api.assets({ q: H.q, limit: 50 })).assets;
      } catch (error) {
        fail(error);
      }
      renderHistory();
    };
    el.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'show') {
        const [domain, id] = e.target
          .closest('[data-key]')
          .dataset.key.split(':');
        const a = H.assets.find((x) => x.domain === domain && x.id === id);
        showTrack(domain, id, a?.label);
      }
      if (act === 'clear') {
        H.selected = null;
        globe.setTrack(null);
        renderHistory();
      }
    };
    const sel = $('[data-in="window"]', el);
    if (sel)
      sel.addEventListener('change', () => {
        H.window = sel.value;
        showTrack(H.selected.domain, H.selected.id, H.selected.label);
      });
  }

  async function showTrack(domain, id, label, range) {
    try {
      const now = Date.now();
      const from = range?.from ?? now - WINDOWS[H.window];
      const to = range?.to ?? now;
      const data = await api.track({
        domain,
        id,
        from: Math.round(from),
        to: Math.round(Math.min(to, now)),
        limit: 20000,
      });
      H.selected = { domain, id, label: label || data.asset?.label };
      H.count = data.fixes.length;
      globe.setTrack(data.fixes, domain);
      if (!data.fixes.length)
        toast('No recorded fixes in that window', 'warning');
      else {
        const last = data.fixes[data.fixes.length - 1];
        globe.flyTo(last.lat, last.lon, domain === 'air' ? 60000 : 15000);
      }
      if (state.tab === 'history' && !panel.hidden) renderHistory();
    } catch (error) {
      fail(error);
    }
  }

  // ------------------------------------------------------------ cameras
  const C = {
    grid: null,
    health: null,
    selected: null,
    series: null,
    confident: false,
  };

  function renderCameras() {
    const el = pane('cameras');
    const s = C.grid?.summary;
    el.innerHTML = `
      <div class="gev-form">
        <label class="gev-check"><input type="checkbox" data-in="confident" ${C.confident ? 'checked' : ''}> Confident poses only</label>
        <div class="gev-row"><button type="button" data-act="coverage">Map coverage in this view</button><button type="button" data-act="clear-cov" ${C.grid ? '' : 'disabled'}>Clear</button></div>
        ${
          s
            ? `<p class="gev-meta">${s.cameras} cameras (${s.lowConfidence} low-confidence pose, ${s.unoriented} no heading).
               Seen by ≥1: ${s.coveredKm2.toFixed(2)} km² of ${s.boxKm2.toFixed(1)} km²; by ≥2: ${s.multiKm2.toFixed(2)} km². Cell ${Math.round(C.grid.cellM)} m.</p>
               <div class="gev-legend"><i class="c1"></i>1 camera <i class="c2"></i>2 <i class="c3"></i>3+ <i class="cf"></i>footprint</div>
               <p class="gev-hint">Footprints are estimates from published poses. Many public cameras pan, and headings marked low-confidence are guesses.</p>`
            : '<p class="gev-hint">Zoom to a neighbourhood or corridor (under 1° across), then map coverage.</p>'
        }
      </div>
      <h4>Camera uptime, last 24 h</h4>
      ${
        C.health
          ? C.health.length
            ? `<ul class="gev-list compact">${C.health
                .slice(0, 40)
                .map(
                  (
                    c,
                  ) => `<li data-cam="${esc(c.camera)}" class="${C.selected === c.camera ? 'selected' : ''}">
                  <div class="gev-title">${esc(c.name || c.camera)}</div>
                  <div class="gev-meta">${esc(c.provider || '')} · ${c.uptime === null ? '—' : `${Math.round(c.uptime * 100)}% up`} · ${c.samples} samples</div>
                  ${C.selected === c.camera && C.series ? `<svg class="gev-spark" viewBox="0 0 240 32" preserveAspectRatio="none"><path d="${sparklinePath(C.series, 240, 30)}" /></svg>` : ''}
                  <div class="gev-actions">${Number.isFinite(c.lat) ? '<button type="button" data-act="fly-cam">Fly</button>' : ''}<button type="button" data-act="series">7-day</button></div></li>`,
                )
                .join('')}</ul>`
            : '<p class="gev-hint">No samples yet. Uptime is recorded as cameras are viewed in the CCTV layer.</p>'
          : '<p class="gev-meta">Loading…</p>'
      }`;
    el.onchange = (e) => {
      if (e.target.dataset.in === 'confident') C.confident = e.target.checked;
    };
    el.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      try {
        if (act === 'coverage') {
          const bbox = viewBbox(globe.viewRect(), 1);
          if (!bbox)
            return toast(
              'Zoom in further: coverage works on views under 1° across',
              'warning',
            );
          C.grid = await api.coverage({
            bbox: bboxParam(bbox),
            cell: 20,
            confident: C.confident ? 1 : undefined,
          });
          globe.setCoverage(C.grid);
          if (!C.grid.summary.cameras)
            toast('No catalog cameras in this view', 'warning');
        }
        if (act === 'clear-cov') {
          C.grid = null;
          globe.setCoverage(null);
        }
        const cam = e.target.closest('[data-cam]')?.dataset.cam;
        const row = C.health?.find((x) => x.camera === cam);
        if (act === 'fly-cam' && row)
          return globe.flyTo(row.lat, row.lon, 1200);
        if (act === 'series' && cam) {
          C.selected = cam;
          C.series = (
            await api.cameraSeries({ camera: cam, from: '-7d' })
          ).series;
        }
      } catch (error) {
        fail(error);
      }
      renderCameras();
    };
    if (!C.health)
      api
        .cameraHealth({ from: '-24h' })
        .then((d) => {
          C.health = d.cameras;
          if (state.tab === 'cameras' && !panel.hidden) renderCameras();
        })
        .catch((error) => {
          C.health = [];
          fail(error);
        });
  }

  // ------------------------------------------------------------ status + boot
  async function refreshStatus() {
    try {
      const s = await api.historyStatus();
      R.oldest = s.store.oldest;
      const live =
        statusEl.dataset.stream === 'live'
          ? 'alerts live'
          : 'alerts reconnecting';
      statusEl.textContent = `${s.store.fixes.toLocaleString()} fixes · ${s.store.assets.toLocaleString()} assets recorded · ${live}`;
    } catch {
      statusEl.textContent = 'history service unavailable';
    }
  }

  (async () => {
    try {
      await loadWatch();
      state.alerts = (await api.alerts({ since: '-24h', limit: 500 })).alerts;
      updateBadge();
    } catch (error) {
      statusEl.textContent = `ops services unavailable (${error.message})`;
    }
    connectStream();
    refreshStatus();
  })();
  timers.push(setInterval(refreshStatus, 30_000));
  const raf = () => {
    if (state.destroyed) return;
    tickReplay().finally(() => requestAnimationFrame(raf));
  };
  requestAnimationFrame(raf);
  renderTab();

  return {
    open: () => open(true),
    close: () => open(false),
    select: (tab) => {
      state.tab = tab;
      open(true);
    },
    flyTo: (lat, lon, height) => globe.flyTo(lat, lon, height),
    viewRect: () => globe.viewRect(),
    destroy() {
      state.destroyed = true;
      for (const t of timers) clearInterval(t);
      stream?.close();
      documentRef.removeEventListener('keydown', onKey);
      globe.destroy();
      root.remove();
    },
  };
}
