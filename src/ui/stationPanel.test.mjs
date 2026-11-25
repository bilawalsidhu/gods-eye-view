// src/ui/stationPanel.test.mjs — the STATION panel renders what the
// satellites layer publishes, over happy-dom; its controls reach the owner.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useStationStore } from './stores/station.js';
import StationPanel from './views/panels/StationPanel.vue';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(StationPanel).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useStationStore(pinia);
  const acted = [];
  store.connect({
    setStationMode: (mode) => acted.push(['mode', mode]),
    chooseStation: (group, choice) => acted.push(['choose', group, choice]),
    slideStation: (slider, value) => acted.push(['slide', slider, value]),
    resumeStationArm: (group) => acted.push(['resume', group]),
    zoomStation: () => acted.push(['zoom']),
  });
  const $ = (id) => document.getElementById(id);
  const publish = async (view) => {
    store.publish(
      view && {
        key: 'iss',
        title: 'ISS',
        subject: 'ISS (ZARYA)',
        mode: 'automatic',
        telemetry: { state: 'live', poseAgeMs: 4200, liveUntilMs: null },
        sunlit: true,
        note: 'Computed, not live telemetry.',
        groups: [
          {
            id: 'sun',
            label: 'Sun position',
            note: null,
            kind: 'choices',
            choices: [
              { id: 'follow', label: 'Follow the Sun', active: true },
              { id: 'ahead', label: 'Ahead', active: false },
            ],
          },
          {
            id: 'arm',
            label: 'Canadarm2 (degrees)',
            note: null,
            kind: 'sliders',
            resume: 'Resume sway',
            sliders: [
              {
                id: 'shoulder',
                label: 'Shoulder roll',
                min: -120,
                max: 120,
                value: 15,
              },
            ],
          },
        ],
        zoom: { offered: false, label: 'Zoom to the ISS' },
        ...view,
      },
    );
    await nextTick();
  };
  const telemetryText = () => $('station-telemetry').textContent.trim();
  return { $, publish, acted, telemetryText };
}

test('without a view the section is hidden', (t) => {
  const { $ } = fixture(t);
  assert.equal($('station-panel').hidden, true);
  assert.equal($('station-badge').textContent, '');
});

test('Automatic shows the subject, the live telemetry age, the Sun line and the note', async (t) => {
  const { $, publish, telemetryText } = fixture(t);
  await publish({});
  const panel = $('station-panel');
  assert.equal(panel.hidden, false);
  assert.equal($('station-badge').textContent, 'ISS');
  assert.equal(
    panel.querySelector('.station-subject').textContent,
    'ISS (ZARYA)',
  );
  assert.equal($('station-automatic-btn').getAttribute('aria-checked'), 'true');
  assert.equal(
    $('station-automatic-btn').classList.contains('is-active'),
    true,
  );
  assert.equal($('station-manual-btn').getAttribute('aria-checked'), 'false');
  assert.equal(telemetryText(), 'Telemetry · updated 4 s ago');
  assert.equal($('station-telemetry').dataset.tone, 'live');
  assert.equal($('station-sun').textContent, 'Now: in sunlight');
  assert.equal(
    panel.querySelectorAll('.station-group').length,
    0,
    'no controls in Automatic',
  );
  assert.equal($('station-zoom-btn'), null);
});

test('the status line words each telemetry state, with ages in seconds or minutes', async (t) => {
  const { $, publish, telemetryText } = fixture(t);
  await publish({
    telemetry: { state: 'live', poseAgeMs: 95_000, liveUntilMs: null },
  });
  assert.equal(telemetryText(), 'Telemetry · updated 2 min ago');
  await publish({
    telemetry: { state: 'no-signal', poseAgeMs: null, liveUntilMs: null },
  });
  assert.equal(telemetryText(), 'No signal · computed values');
  assert.equal($('station-telemetry').dataset.tone, 'waiting');
  await publish({
    telemetry: {
      state: 'no-signal',
      poseAgeMs: 30_000,
      liveUntilMs: Date.UTC(2026, 10, 13, 12, 0),
    },
  });
  assert.match(telemetryText(), /^No signal since \S.* · computed values$/);
  await publish({
    telemetry: { state: 'unavailable', poseAgeMs: 50_000, liveUntilMs: null },
  });
  assert.equal(
    telemetryText(),
    'Telemetry unavailable · last update 50 s ago · computed values',
  );
  assert.equal($('station-telemetry').dataset.tone, 'off');
  await publish({
    telemetry: { state: 'unavailable', poseAgeMs: null, liveUntilMs: null },
  });
  assert.equal(telemetryText(), 'Telemetry unavailable · computed values');
  await publish({
    telemetry: { state: 'disabled', poseAgeMs: null, liveUntilMs: null },
  });
  assert.equal(
    telemetryText(),
    'Telemetry not enabled on this server · computed values',
  );
  // A station with no feed at all (Tiangong).
  await publish({
    telemetry: { state: 'none', poseAgeMs: null, liveUntilMs: null },
  });
  assert.equal(telemetryText(), 'No public telemetry · computed values');
  assert.equal($('station-telemetry').dataset.tone, 'off');
  await publish({
    telemetry: { state: 'pending', poseAgeMs: null, liveUntilMs: null },
  });
  assert.equal(telemetryText(), 'Connecting to telemetry…');
  assert.equal($('station-telemetry').dataset.tone, 'waiting');
  await publish({
    telemetry: { state: 'idle', poseAgeMs: null, liveUntilMs: null },
  });
  assert.equal(telemetryText(), 'Telemetry reads while the model is on screen');
  assert.equal($('station-telemetry').dataset.tone, 'off');
  await publish({ sunlit: false });
  assert.equal($('station-sun').textContent, "Now: in the Earth's shadow");
});

test('Manual shows the groups with the active choice, the sliders and the resume button', async (t) => {
  const { $, publish, telemetryText, acted } = fixture(t);
  await publish({ mode: 'manual', sunlit: null });
  const panel = $('station-panel');
  assert.equal(panel.classList.contains('station-manual'), true);
  assert.equal($('station-manual-btn').getAttribute('aria-checked'), 'true');
  assert.equal(telemetryText(), 'Manual · telemetry paused');
  assert.equal($('station-telemetry').dataset.tone, 'manual');
  assert.equal($('station-sun'), null);
  assert.equal(panel.querySelectorAll('.station-group').length, 2);
  const follow = panel.querySelector('[data-station-choice="sun:follow"]');
  const ahead = panel.querySelector('[data-station-choice="sun:ahead"]');
  assert.equal(follow.getAttribute('aria-pressed'), 'true');
  assert.equal(follow.classList.contains('is-active'), true);
  assert.equal(ahead.getAttribute('aria-pressed'), 'false');
  ahead.click();
  const slider = $('station-slider-shoulder');
  assert.ok(slider, 'the slider is in the page');
  assert.equal(
    panel.querySelector('.station-slider output').textContent,
    '15°',
  );
  panel.querySelector('[data-station-resume="arm"]').click();
  assert.deepEqual(acted, [
    ['choose', 'sun', 'ahead'],
    ['resume', 'arm'],
  ]);
});

test('the mode buttons and the zoom button call the owner', async (t) => {
  const { $, publish, acted } = fixture(t);
  await publish({ zoom: { offered: true, label: 'Zoom to the ISS' } });
  $('station-manual-btn').click();
  $('station-automatic-btn').click();
  assert.equal($('station-zoom-btn').textContent, 'Zoom to the ISS');
  $('station-zoom-btn').click();
  assert.deepEqual(acted, [
    ['mode', 'manual'],
    ['mode', 'automatic'],
    ['zoom'],
  ]);
});

test('publishing null hides the section again', async (t) => {
  const { $, publish } = fixture(t);
  await publish({});
  await publish(null);
  assert.equal($('station-panel').hidden, true);
});
