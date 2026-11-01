/** External-player cases for qa-camera-controls.mjs; all providers are fixtures. */
export const embedSources = [
  ['youtube', 'https://www.youtube.com/watch?v=r8Busmkpsh8'],
  ['twitch', 'https://www.twitch.tv/qa_camera'],
  ['angelcam', 'https://v.angelcam.com/iframe?v=qa12345678'],
  ['roundshot', 'https://example.roundshot.com/'],
].map(([provider, embedUrl]) => ({
  id: `qa-${provider}`,
  name: `QA ${provider}`,
  city: 'Austin',
  cityId: 'austin',
  provider,
  lat: 30.2747,
  lon: -97.7403,
  feedType: 'embed',
  feedConfigured: true,
  embedUrl,
  sourcePageUrl: embedUrl,
}));

const hosts = new Set([
  'www.youtube-nocookie.com',
  'player.twitch.tv',
  'v.angelcam.com',
  'example.roundshot.com',
]);
const playerHosts = [...hosts];

/** Exercise a real cross-origin iframe without depending on a live broadcast. */
export function answerEmbedRequest(request) {
  if (!hosts.has(new URL(request.url()).hostname)) return false;
  void request.respond({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0;background:#16364d;color:white;font:16px sans-serif" data-state="ready">
      <button id="play" style="margin:20px;padding:20px">Play fixture</button>
      <output id="status">Ready</output><video muted playsinline style="display:block;width:100%"></video>
      <script>document.getElementById('play').onclick = async () => {
        const video = document.querySelector('video');
        if (!video.srcObject) {
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 180;
          const context = canvas.getContext('2d');
          let frame = 0;
          const draw = () => {
            context.fillStyle = '#16364d'; context.fillRect(0, 0, 320, 180);
            context.fillStyle = '#00e5ff'; context.font = '24px sans-serif';
            context.fillText('Fixture frame ' + frame++, 20, 90);
          };
          draw(); setInterval(draw, 100);
          video.srcObject = canvas.captureStream(10);
        }
        await video.play();
        document.body.dataset.state = 'playing';
        document.getElementById('status').textContent = 'Playing fixture';
      };</script></body></html>`,
  });
  return true;
}

const camerasTab = '#mobile-tab-bar [data-mobile-sheet="cameras"]';
const disclosure = '#cctv-panel [data-collapse-target="cctv-panel"]';

/** Verify selection, visibility ownership and authored panel state on phones. */
export async function checkCameraEmbeds(page, check) {
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const resize = async (width, height) => {
    await page.setViewport({ width, height, hasTouch: true });
    await page.waitForFunction(
      (phone) => document.body.classList.contains('mobile-shell') === phone,
      {},
      width <= 720,
    );
    await settle();
  };
  const sheet = async (name) => {
    await page.click(`#mobile-tab-bar [data-mobile-sheet="${name}"]`);
    await settle();
  };
  const panelState = () =>
    page.evaluate(() => {
      const ui = window.__godsEyeView.styleManager;
      const ids = ['cctv-panel', 'street-level-panel'];
      const state = ui._cctvControls.getState();
      return {
        coverageMode: state.coverageMode,
        showProjection: state.showProjection,
        autoHop: state.autoHop,
        shared: ui
          ._buildSharePanelState()
          .specs.filter(({ id }) => ids.includes(id)),
        stored: ids.map((id) =>
          localStorage.getItem(
            ui._panelChrome._panelPosition._panelCollapseStorageKey(id),
          ),
        ),
      };
    });
  const activeId = () =>
    page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
          .activeCameraId,
    );
  const iframe = () => page.$('#cctv-panel iframe.cctv-embed');
  const absent = async (label) => check(label, (await iframe()) === null);
  const remember = () =>
    page.evaluate(() => {
      window.__qaPreviousPlayer = document.querySelector('#cctv-panel iframe');
    });
  const replaced = () =>
    page.evaluate(() => {
      const current = document.querySelector('#cctv-panel iframe');
      return (
        current &&
        current !== window.__qaPreviousPlayer &&
        !window.__qaPreviousPlayer?.isConnected &&
        document.querySelectorAll('#cctv-panel iframe').length === 1
      );
    });
  const play = async (label) => {
    const handle = await page.waitForSelector('#cctv-panel iframe.cctv-embed');
    const frame = await handle.contentFrame();
    await frame.waitForSelector('#play');
    await frame.click('#play');
    await frame.waitForFunction(() => {
      const video = document.querySelector('video');
      return !video.paused && video.currentTime > 0;
    });
    check(
      `${label}: selected fixture accepts Play inside the provider iframe`,
      await frame.$eval('body', (body) => body.dataset.state === 'playing'),
    );
  };
  const touch = await page.createCDPSession();
  const gesture = async (selector, dx, dy, cancel = false) => {
    const point = await page.$eval(selector, (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + Math.min(rect.width / 2, 100), y: rect.top + 8 };
    });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...point, id: 1 }],
    });
    // Small first move claims direction before Chromium's native scroll slop.
    for (let step = 1; step <= 16; step++) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: point.x + (dx * step) / 16,
            y: point.y + (dy * step) / 16,
            id: 1,
          },
        ],
      });
    }
    await touch.send('Input.dispatchTouchEvent', {
      type: cancel ? 'touchCancel' : 'touchEnd',
      touchPoints: [],
    });
    await settle();
  };
  const resetScroll = () =>
    page.$eval('#right-context-rail', (rail) => {
      for (const node of [rail, ...rail.querySelectorAll('*')]) {
        if (node.scrollTop) node.scrollTop = 0;
      }
    });
  const stillPlaying = async () => {
    const handle = await iframe();
    if (!handle) return false;
    const frame = await handle.contentFrame();
    return frame.$eval(
      'video',
      (video) => !video.paused && video.currentTime > 0,
    );
  };
  const swipeCases = async (source, width) => {
    const label = `${source.provider} ${width}px`;
    await resetScroll();
    await remember();
    const handle = await iframe();
    const oldFrame = await handle.contentFrame();
    // Retain a media handle so destruction is checked beyond DOM removal.
    const oldVideo = await oldFrame.$('video');
    const unchanged = async (name) =>
      check(
        `${label}: ${name}`,
        (await page.evaluate(
          () =>
            document.body.dataset.mobileSheet === 'cameras' &&
            document.querySelector('#cctv-panel iframe') ===
              window.__qaPreviousPlayer,
        )) && (await stillPlaying()),
      );
    const title = '#cctv-panel .panel-title';
    await gesture(title, 90, 8);
    await unchanged('horizontal gesture keeps the same playing iframe');
    await gesture(title, 0, 48);
    await unchanged('pull below 64px keeps Cameras open');
    await gesture(title, 0, 80, true);
    await unchanged('cancelled downward pull keeps Cameras open');
    // The provider button is a real control in the cross-origin document.
    await oldFrame.tap('#play');
    await unchanged('tapping a provider control keeps Cameras open');
    for (let i = 0; i < 3; i++) await page.tap('#cctv-coverage-btn');
    await unchanged('tapping panel controls keeps Cameras open');
    await resetScroll();
    await gesture('#cctv-panel .panel-collapse-btn', 0, 80, true);
    await unchanged(
      'cancelled gesture on a panel control does not close Cameras',
    );

    // Controlled nested overflow tests native scrolling inside the borrowed
    // panel, with the real shell listeners and no synthetic DOM touch events.
    await page.$eval('#cctv-panel .panel-header', (header) => {
      const scroller = document.createElement('div');
      scroller.id = 'qa-camera-scroll';
      scroller.style.cssText = 'height:100px;overflow:auto;flex:none';
      scroller.innerHTML =
        '<div style="height:500px">Camera scroll fixture</div>';
      header.after(scroller);
    });
    await gesture('#qa-camera-scroll', 0, -80);
    check(
      `${label}: upward content gesture scrolls natively`,
      await page.$eval('#qa-camera-scroll', (node) => node.scrollTop > 0),
    );
    await unchanged('scrolling content keeps the player alive');
    await page.$eval('#qa-camera-scroll', (node) => {
      node.scrollTop = 120;
    });
    await gesture('#qa-camera-scroll', 0, 80);
    check(
      `${label}: downward gesture from scrolled content scrolls toward the top`,
      await page.$eval('#qa-camera-scroll', (node) => node.scrollTop < 120),
    );
    await unchanged('downward content scroll does not dismiss Cameras');
    await page.$eval('#qa-camera-scroll', (node) => node.remove());
    await resetScroll();
    await gesture(title, 0, 80);
    await page.waitForFunction(
      () => !document.querySelector('#cctv-panel iframe'),
    );
    await absent(`${label}: downward swipe removes the active iframe`);
    check(
      `${label}: swipe detaches the provider browsing context`,
      oldFrame.detached,
    );
    let released = false;
    try {
      await oldVideo.evaluate((video) => video.currentTime);
    } catch {
      released = true;
    }
    check(
      `${label}: removed player media context is no longer executable`,
      released,
    );
    await oldVideo.dispose();
    check(
      `${label}: swipe preserves selection, preferences and returns focus`,
      (await activeId()) === source.id &&
        JSON.stringify(await panelState()) === JSON.stringify(initialPanels) &&
        (await page.$eval(
          camerasTab,
          (tab) =>
            document.activeElement === tab &&
            tab.getAttribute('aria-expanded') === 'false',
        )),
    );
    await sheet('cameras');
    await play(`${label} after swipe`);
    check(
      `${label}: reopening creates exactly one fresh selected player`,
      (await replaced()) && (await activeId()) === source.id,
    );
  };
  const fits = () =>
    page.evaluate(() => {
      const panel = document
        .getElementById('cctv-panel')
        .getBoundingClientRect();
      const rail = document
        .getElementById('right-context-rail')
        .getBoundingClientRect();
      const tabs = document
        .getElementById('mobile-tab-bar')
        .getBoundingClientRect();
      return (
        panel.width > 0 &&
        panel.left >= 0 &&
        panel.right <= innerWidth + 1 &&
        rail.top >= 0 &&
        rail.bottom <= tabs.top + 1 &&
        document.documentElement.scrollWidth <= innerWidth
      );
    });

  // Expanded desktop CCTV is intentional: closing a phone sheet must stop its
  // player even when there is no collapsed-class change to observe.
  await resize(1440, 900);
  await page.evaluate(() => {
    const ui = window.__godsEyeView.styleManager;
    ui.setPanelCollapsed('cctv-panel', false, { explicit: true });
    ui.setPanelCollapsed('street-level-panel', true, { explicit: true });
  });
  await page.select('#cctv-camera-select', 'qa-youtube');
  await play('desktop YouTube');
  await remember();
  const initialPanels = await panelState();
  await resize(390, 844);
  await absent(
    'entering phone layout stops the desktop player while Cameras is closed',
  );
  check(
    'entering phone layout preserves selection',
    (await activeId()) === 'qa-youtube',
  );
  await sheet('cameras');
  await play('phone YouTube');
  check('opening Cameras recreates exactly one player', await replaced());
  check(
    'Cameras borrows CCTV and Street Level without altering shared or saved panel state',
    JSON.stringify(await panelState()) === JSON.stringify(initialPanels),
  );

  for (const [index, source] of embedSources.entries()) {
    await remember();
    const prior = await activeId();
    await page.select('#cctv-camera-select', source.id);
    await play(`phone ${source.provider}`);
    check(
      `${source.provider}: selection and official-page fallback agree`,
      await page.evaluate(
        (expected, host) => {
          const link = document.querySelector('.cctv-embed-source');
          const player = document.querySelector('iframe.cctv-embed');
          return (
            document.getElementById('cctv-camera-select').value ===
              expected.id &&
            link.href === expected.sourcePageUrl &&
            link.target === '_blank' &&
            link.rel === 'noopener noreferrer' &&
            new URL(player.src).hostname === host &&
            player.title.includes(expected.name)
          );
        },
        source,
        playerHosts[index],
      ),
    );
    if (prior !== source.id)
      check(
        `${source.provider}: switching removes the old iframe`,
        await replaced(),
      );
    check(
      `${source.provider}: 390 × 844 sheet stays inside the viewport`,
      await fits(),
    );
    if (source.provider === 'twitch') {
      check(
        'Twitch keeps its required viewport and scrolls inside the camera preview',
        await page.evaluate(() => {
          const player = document.querySelector('.cctv-embed-twitch');
          const wrap = document.getElementById('cctv-frame-wrap');
          const rect = player.getBoundingClientRect();
          wrap.scrollLeft = 1000;
          return (
            rect.width >= 400 &&
            rect.height >= 300 &&
            wrap.scrollLeft > 0 &&
            new URL(player.src).searchParams.get('parent') === location.hostname
          );
        }),
      );
      await page.$eval('#cctv-frame-wrap', (wrap) => {
        wrap.scrollLeft = 0;
      });
    }
    await remember();
    await page.evaluate(() => {
      const controls = window.__godsEyeView.styleManager._cctvControls;
      controls._renderCctvState(controls.getState());
    });
    check(
      `${source.provider}: a state refresh preserves the playing iframe`,
      await page.evaluate(
        () =>
          document.querySelector('#cctv-panel iframe') ===
          window.__qaPreviousPlayer,
      ),
    );
    await page.screenshot({
      path: `qa-shots/camera-controls/phone-${source.provider}.png`,
    });
    const tabClosedFrame = await (await iframe()).contentFrame();
    await sheet('cameras');
    await absent(`${source.provider}: closing Cameras removes the iframe`);
    check(
      `${source.provider}: tab closure destroys the provider context`,
      tabClosedFrame.detached,
    );
    check(
      `${source.provider}: closing Cameras preserves selection and panel preferences`,
      (await activeId()) === source.id &&
        JSON.stringify(await panelState()) === JSON.stringify(initialPanels),
    );
    check(
      `${source.provider}: closing returns focus to the Cameras tab`,
      await page.$eval(
        camerasTab,
        (tab) =>
          document.activeElement === tab &&
          tab.getAttribute('aria-expanded') === 'false',
      ),
    );
    await sheet('cameras');
    await play(`reopened ${source.provider}`);
    check(
      `${source.provider}: reopening replaces the removed player exactly once`,
      await replaced(),
    );
    await swipeCases(source, 390);
  }

  await remember();
  await sheet('context');
  await absent('switching from Cameras to Context stops the external player');
  await sheet('cameras');
  await play('return from Context');
  check(
    'returning from another sheet recreates the selected player',
    await replaced(),
  );
  await page.focus('#cctv-camera-select');
  await page.keyboard.press('Escape');
  await settle();
  await absent('Escape closes Cameras and stops the player');
  check(
    'Escape returns focus without collapsing the authored CCTV panel',
    (await page.$eval(camerasTab, (tab) => document.activeElement === tab)) &&
      JSON.stringify(await panelState()) === JSON.stringify(initialPanels),
  );
  await sheet('cameras');
  await play('after Escape');
  // Click the exposed backdrop, not through the sheet.
  await page.click('#mobile-sheet-backdrop', { offset: { x: 5, y: 180 } });
  await settle();
  await absent('the backdrop closes Cameras and stops the player');
  await sheet('cameras');
  await play('after backdrop');

  await page.click(disclosure);
  await settle();
  await absent(
    'explicit CCTV collapse stops the player inside an open Cameras sheet',
  );
  const collapsedPanels = await panelState();
  await sheet('cameras');
  await sheet('cameras');
  await play('temporarily borrowed collapsed CCTV');
  check(
    'borrowing a user-collapsed panel preserves its shared and stored preference',
    JSON.stringify(await panelState()) === JSON.stringify(collapsedPanels),
  );
  await resize(1440, 900);
  await absent(
    'phone-to-desktop restores a user-collapsed CCTV panel without a hidden player',
  );
  check(
    'desktop restores the authored panel state and closes the phone sheet',
    JSON.stringify(await panelState()) === JSON.stringify(collapsedPanels) &&
      (await page.evaluate(
        () => !document.body.hasAttribute('data-mobile-sheet'),
      )),
  );
  await page.click(disclosure);
  await play('desktop after explicit expansion');
  await remember();
  await resize(390, 844);
  await absent('returning to phone closes the expanded desktop player');
  await sheet('cameras');
  await play('phone after second transition');
  await remember();
  await resize(721, 844);
  check(
    'crossing to desktop with an expanded panel preserves the existing player',
    await page.evaluate(
      () =>
        document.querySelector('#cctv-panel iframe') ===
        window.__qaPreviousPlayer,
    ),
  );
  await resize(720, 844);
  await absent('the 720px boundary closes the player with the phone sheet');
  await sheet('cameras');
  await play('720px phone boundary');
  for (const source of embedSources) {
    await page.select('#cctv-camera-select', source.id);
    await play(`720px ${source.provider}`);
    await swipeCases(source, 720);
    await remember();
    await resize(721, 844);
    await resetScroll();
    await gesture('#cctv-panel .panel-title', 0, 80);
    check(
      `${source.provider} 721px: touch pull leaves desktop player intact`,
      (await page.evaluate(
        () =>
          !document.body.classList.contains('mobile-shell') &&
          !document.body.hasAttribute('data-mobile-sheet') &&
          document.querySelector('#cctv-panel iframe') ===
            window.__qaPreviousPlayer,
      )) && (await stillPlaying()),
    );
    await resize(720, 844);
    await absent(
      `${source.provider}: returning from 721px removes hidden player`,
    );
    await sheet('cameras');
    await play(`720px restored ${source.provider}`);
  }
  await resize(390, 844);
  check(
    'resizing within phone layout keeps Cameras open and inside the viewport',
    (await fits()) &&
      (await page.evaluate(
        () => document.body.dataset.mobileSheet === 'cameras',
      )),
  );

  await remember();
  await page.select('#cctv-camera-select', 'qa-camera-a');
  await page.waitForFunction(() =>
    document.getElementById('cctv-frame-wrap').classList.contains('has-frame'),
  );
  await absent('switching to a native snapshot removes the external player');
  await page.select('#cctv-camera-select', 'qa-youtube');
  await play('external after native snapshot');
  check(
    'switching back from native playback creates a fresh player',
    await replaced(),
  );
  await page.click('#cctv-enable-btn');
  await settle();
  await absent('disabling CCTV removes the external player');
  await page.click('#cctv-enable-btn');
  await play('re-enabled CCTV');
  await remember();
  // Headless Shell has no tab activation model. CDP produces the browser's
  // real visibilitychange event; do not replace document.hidden or the handler.
  const lifecycle = await page.createCDPSession();
  await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
  check(
    'page suspension makes the document hidden',
    await page.evaluate(() => document.hidden),
  );
  await absent('page suspension removes the external player');
  await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
  await lifecycle.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await play('visible CCTV after suspension');
  check(
    'restoring page visibility recreates one selected player',
    await replaced(),
  );
  // Leave a live fixture for the parent harness to exercise real UI disposal.
}
