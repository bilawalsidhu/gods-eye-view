import './style.css';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createGlobe } from './globe.js';
import { createSpatialData, LAYERS, feedLabel } from './data.js';
import { REGIONS } from './geo.js';
import { mountSpatialUI, spatialBrand } from './ui.js';
import { createSessionController } from './session.js';
import { XRToolkit } from './vendor/xr-toolkit.js';
import { PanelManager } from './vendor/panels/manager.js';
import { PanelInput } from './vendor/panels/input.js';
import { createSurfacePlacement } from './vendor/mr-placement.js';
import { headPosition, headDirection } from './vendor/xr-head.js';

const abort = new AbortController();
let renderer,
  globe,
  panels,
  toolkit,
  placement,
  sessions,
  data,
  selected = null,
  tab = 'layers',
  destroyed = false;
let controlsPanel,
  infoPanel,
  regionIndex = 0,
  frameCount = 0,
  fps = 0,
  frameWindow = 0,
  savedDesktop;
const ui = mountSpatialUI({ onAction: action });
const scene = new THREE.Scene();
scene.background = new THREE.Color('#060e18');
const camera = new THREE.PerspectiveCamera(48, 1, 0.025, 80);
const rig = new THREE.Group();
scene.add(rig);
rig.add(camera);
camera.position.set(0, 1.55, 1);
camera.lookAt(0, 1.3, -1.8);
const environment = new THREE.Group();
scene.add(environment);
scene.add(new THREE.HemisphereLight('#c2ede7', '#0d2533', 2.4));
const sun = new THREE.DirectionalLight('#e9faff', 2.3);
sun.position.set(-3, 5, 4);
scene.add(sun);
const floor = new THREE.GridHelper(10, 40, '#244956', '#122b38');
floor.position.y = -0.01;
environment.add(floor);

function status(message) {
  ui.status(message);
  if (infoPanel && !selected) updateInfo(message);
}

function controlContent() {
  let actions;
  if (tab === 'layers')
    actions = LAYERS.map((layer) => ({
      id: 'layer:' + layer.id,
      label: layer.name,
      selected: data.states[layer.id].enabled,
    }));
  else if (tab === 'globe')
    actions = [
      { id: 'region-next', label: 'Region: ' + REGIONS[regionIndex].name },
      { id: 'rotate-left', label: 'Rotate left' },
      { id: 'rotate-right', label: 'Rotate right' },
      { id: 'smaller', label: 'Smaller globe' },
      { id: 'larger', label: 'Larger globe' },
    ];
  else
    actions = [
      { id: 'recenter', label: 'Recenter workspace' },
      { id: 'refresh', label: 'Refresh feeds' },
      {
        id: 'controller-visual',
        label:
          toolkit?.controllerVisual === 'hand'
            ? 'Show controllers'
            : 'Show controller hands',
      },
      {
        id: 'place-surface',
        label: 'Place on surface',
        enabled: placement?.hasSurface === true,
      },
      { id: 'exit', label: 'Exit headset' },
    ];
  return {
    taskId: tab,
    title: 'Spatial controls',
    eyebrow: tab.toUpperCase(),
    actions: [
      ...actions,
      {
        id:
          'tab:' +
          (tab === 'layers' ? 'globe' : tab === 'globe' ? 'tools' : 'layers'),
        label:
          tab === 'layers'
            ? 'Globe controls →'
            : tab === 'globe'
              ? 'Workspace tools →'
              : 'Intelligence layers →',
        primary: true,
      },
    ],
    footer: 'Trigger or pinch · white bar to move panel',
  };
}

function updateInfo(message) {
  if (!infoPanel) return;
  const blocks = selected
    ? [
        { type: 'text', label: 'Contact', text: selected.name },
        {
          type: 'text',
          label: 'Location',
          text: `${selected.lat.toFixed(3)}°, ${selected.lon.toFixed(3)}°\n${selected.detail}`,
        },
        {
          type: 'text',
          label: 'Source',
          text: `${data.states[selected.layer].source}\n${feedLabel(data.states[selected.layer])}\n${selected.observedAtMs ? new Date(selected.observedAtMs).toISOString() : 'Observation time unknown'}`,
        },
      ]
    : LAYERS.filter((l) => data?.states[l.id].enabled).map((l) => ({
        type: 'text',
        label: l.name,
        text: feedLabel(data.states[l.id]),
      }));
  if (!selected && message) blocks.unshift({ type: 'text', text: message });
  infoPanel.setContent({
    taskId: selected ? 'contact' : 'feeds',
    title: selected ? 'Contact details' : 'Observatory',
    eyebrow: selected ? selected.layer.toUpperCase() : 'SOURCE STATUS',
    blocks,
    actions: selected
      ? [{ id: 'clear-contact', label: 'Back to source status', primary: true }]
      : [],
    footer: `${sessions?.state().selected || 'desktop'} · ${fps ? fps + ' fps' : 'frame timing pending'}`,
  });
}

function recenter() {
  const active = renderer?.xr.isPresenting;
  const view = active ? renderer.xr.getCamera() : camera;
  const head = active
      ? headPosition(rig, view)
      : view.getWorldPosition(new THREE.Vector3()),
    direction = active
      ? headDirection(rig, view)
      : view.getWorldDirection(new THREE.Vector3());
  direction.y = 0;
  if (direction.lengthSq() < 0.001) direction.set(0, 0, -1);
  direction.normalize();
  globe.workspace.position.copy(head).addScaledVector(direction, 1.8);
  globe.workspace.position.y = head.y - 0.3;
  globe.workspace.scale.setScalar(1);
  const right = new THREE.Vector3().crossVectors(
    direction,
    new THREE.Vector3(0, 1, 0),
  );
  for (const [panel, side] of [
    [controlsPanel, -1],
    [infoPanel, 1],
  ]) {
    const point = head
      .clone()
      .addScaledVector(direction, 1.25)
      .addScaledVector(right, side * 0.95);
    point.y = head.y - 0.1;
    const matrix = new THREE.Matrix4().lookAt(
      head,
      point,
      new THREE.Vector3(0, 1, 0),
    );
    panel.setPose({
      position: point.toArray(),
      quaternion: new THREE.Quaternion()
        .setFromRotationMatrix(matrix)
        .toArray(),
    });
    panel.show();
  }
  status('Workspace recentered.');
}

function placeOnSurface() {
  if (!sessions?.state().active || !placement?.hasSurface) return;
  const marker = placement.place();
  if (!marker) return;
  globe.workspace.position.copy(marker.position);
  globe.workspace.position.y += globe.workspace.scale.x * 0.65;
  // The template's placement marker is a probe; this app places the actual globe.
  marker.geometry.dispose();
  marker.material.dispose();
  marker.removeFromParent();
  status('Globe placed on the detected surface.');
}

function action(id) {
  if (!globe || destroyed) return;
  if (id.startsWith('layer:')) {
    data.toggle(id.slice(6));
    selected = null;
    globe.clearSelection();
    ui.clearContact();
  } else if (id.startsWith('tab:')) tab = id.slice(4);
  else if (id === 'region-next' || id.startsWith('region:')) {
    regionIndex =
      id === 'region-next'
        ? (regionIndex + 1) % REGIONS.length
        : Number(id.slice(7));
    const region = REGIONS[regionIndex];
    if (!region) return;
    globe.focus(region.lat, region.lon);
    ui.root.querySelector('#region-select').value = String(regionIndex);
    status('Focused on ' + region.name);
  } else if (id === 'rotate-left' || id === 'rotate-right')
    globe.rotate(id === 'rotate-left' ? -Math.PI / 12 : Math.PI / 12);
  else if (id === 'larger' || id === 'smaller')
    globe.scale(id === 'larger' ? 0.15 : -0.15);
  else if (id === 'recenter') recenter();
  else if (id === 'refresh') {
    for (const layer of LAYERS) void data.refresh(layer.id);
    status('Refreshing enabled feeds.');
  } else if (id === 'clear-contact') {
    selected = null;
    globe.clearSelection();
    ui.clearContact();
  } else if (id === 'place-surface') placeOnSurface();
  else if (id === 'exit') void sessions.exit();
  else if (id === 'controller-visual')
    toolkit.setControllerVisual(
      toolkit.controllerVisual === 'hand' ? 'controller' : 'hand',
    );
  controlsPanel?.setContent(controlContent());
  updateInfo();
}

function inspect(record) {
  selected = record;
  ui.contact(record, data.states[record.layer]);
  updateInfo();
}

function desktopInput() {
  let start = null,
    previous = null,
    moved = false;
  const pointer = new THREE.Vector2(),
    raycaster = new THREE.Raycaster();
  const options = { signal: abort.signal };
  ui.canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (renderer.xr.isPresenting || event.button !== 0) return;
      start = previous = { x: event.clientX, y: event.clientY };
      moved = false;
      ui.canvas.setPointerCapture(event.pointerId);
    },
    options,
  );
  ui.canvas.addEventListener(
    'pointermove',
    (event) => {
      if (!start || renderer.xr.isPresenting) return;
      const dx = event.clientX - previous.x,
        dy = event.clientY - previous.y;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)
        moved = true;
      if (moved) {
        globe.rotate(dx * 0.006);
        globe.globe.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), dy * 0.006);
      }
      previous = { x: event.clientX, y: event.clientY };
    },
    options,
  );
  ui.canvas.addEventListener(
    'pointerup',
    (event) => {
      if (!start) return;
      if (!moved) {
        const rect = ui.canvas.getBoundingClientRect();
        pointer.set(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
        globe.selectHit(raycaster.intersectObjects(globe.targets, false)[0]);
      }
      start = previous = null;
    },
    options,
  );
  const cancel = () => {
    start = previous = null;
  };
  ui.canvas.addEventListener('pointercancel', cancel, options);
  ui.canvas.addEventListener('lostpointercapture', cancel, options);
  window.addEventListener('blur', cancel, options);
  ui.canvas.addEventListener(
    'wheel',
    (event) => {
      if (renderer.xr.isPresenting) return;
      event.preventDefault();
      globe.scale(-Math.sign(event.deltaY) * 0.08);
    },
    { signal: abort.signal, passive: false },
  );
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        renderer.xr.isPresenting ||
        /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(event.target?.tagName)
      )
        return;
      const command = {
        ArrowLeft: 'rotate-left',
        ArrowRight: 'rotate-right',
        '+': 'larger',
        '=': 'larger',
        '-': 'smaller',
        r: 'recenter',
        R: 'recenter',
      }[event.key];
      if (command) {
        event.preventDefault();
        action(command);
      }
    },
    options,
  );
}

let heartbeat;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: ui.canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  globe = createGlobe({
    scene,
    signal: abort.signal,
    onSelect: inspect,
    onStatus: status,
  });
  panels = new PanelManager({
    scene,
    renderer,
    brand: spatialBrand,
    onStatus: status,
  });
  panels.collision.registerBox('earth-workspace', globe.sphere);
  data = createSpatialData({
    onChange(states) {
      globe.sync(states);
      ui.feeds(states);
      if (selected) {
        const state = states[selected.layer];
        selected = state.enabled
          ? state.records.find((record) => record.id === selected.id) || null
          : null;
        if (selected) ui.contact(selected, state);
        else {
          globe.clearSelection();
          ui.clearContact();
        }
      }
      controlsPanel?.setContent(controlContent());
      updateInfo();
    },
  });
  controlsPanel = panels.createPanel({
    id: 'controls',
    mode: 'movable',
    pose: {
      position: [-1.05, 1.45, -1.1],
      quaternion: new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0, 0.45, 0))
        .toArray(),
    },
    content: controlContent(),
    onAction: action,
  });
  infoPanel = panels.createPanel({
    id: 'inspector',
    mode: 'movable',
    pose: {
      position: [1.05, 1.45, -1.1],
      quaternion: new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0, -0.45, 0))
        .toArray(),
    },
    content: {
      title: 'Observatory',
      blocks: [
        { type: 'text', text: 'Select a contact on the globe to inspect it.' },
      ],
    },
    onAction: action,
  });
  controlsPanel.hide();
  infoPanel.hide();
  placement = createSurfacePlacement(scene);
  toolkit = new XRToolkit({
    renderer,
    scene,
    rig,
    world: new CANNON.World(),
    grabbables: [],
    targets: globe.targets,
    blockers: [],
    panelInput: new PanelInput(panels),
    handTeleport: false,
    onToast: (message) =>
      status(
        message.includes('block')
          ? 'Select a contact or use Spatial controls. Drag the white panel bar to move it.'
          : message,
      ),
    canTeleport: (point) =>
      Math.abs(point.x) < 4.7 &&
      Math.abs(point.z) < 4.7 &&
      Math.hypot(
        point.x - globe.workspace.position.x,
        point.z - globe.workspace.position.z,
      ) >
        0.85 * globe.workspace.scale.x,
    onTeleport: () => panels.recenter(),
  });
  sessions = createSessionController({
    renderer,
    onStatus: status,
    onChange: (state) => {
      ui.session(state);
    },
    async onStart({ session, mixedReality }) {
      rig.position.set(0, 0, 0);
      rig.quaternion.identity();
      environment.visible = !mixedReality;
      scene.background = mixedReality ? null : new THREE.Color('#060e18');
      toolkit.setMixedReality(mixedReality);
      // Entry pose is defined in floor space; physical head translation remains runtime-owned.
      globe.workspace.position.set(0, 1.25, -1.8);
      globe.workspace.scale.setScalar(1);
      controlsPanel.setPose({
        position: [-1.05, 1.45, -1.1],
        quaternion: new THREE.Quaternion()
          .setFromEuler(new THREE.Euler(0, 0.45, 0))
          .toArray(),
      });
      infoPanel.setPose({
        position: [1.05, 1.45, -1.1],
        quaternion: new THREE.Quaternion()
          .setFromEuler(new THREE.Euler(0, -0.45, 0))
          .toArray(),
      });
      controlsPanel.show();
      infoPanel.show();
      session.addEventListener('select', (event) => {
        const input = toolkit.inputs.find(
          (input) => input.source === event.inputSource,
        );
        if (
          mixedReality &&
          input &&
          !input.aimHit &&
          !input.held &&
          !panels.captured(input)
        )
          placeOnSurface();
      });
      await placement.start(session, mixedReality);
      if (sessions.state().active) {
        panels.room.start(session, mixedReality);
        updateInfo(
          mixedReality && placement.state === 'unsupported'
            ? 'Surface detection unavailable. Use Recenter workspace for virtual placement.'
            : null,
        );
      } else placement.stop();
    },
    onEnd() {
      placement.stop();
      panels.room.stop();
      controlsPanel.hide();
      infoPanel.hide();
      toolkit.setMixedReality(false);
      scene.background = new THREE.Color('#060e18');
      environment.visible = true;
      rig.position.set(0, 0, 0);
      rig.quaternion.identity();
      if (savedDesktop) {
        camera.position.copy(savedDesktop.position);
        camera.quaternion.copy(savedDesktop.quaternion);
        globe.workspace.position.copy(savedDesktop.workspace);
        globe.workspace.scale.copy(savedDesktop.scale);
        savedDesktop = null;
      }
      status('Returned to desktop preview.');
    },
  });
  ui.enterButton.onclick = () => {
    if (sessions.state().active) return sessions.exit();
    // Capture before Three attaches the session and replaces the base camera pose.
    savedDesktop = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      workspace: globe.workspace.position.clone(),
      scale: globe.workspace.scale.clone(),
    };
    return sessions.enter();
  };
  ui.modeSelect.onchange = () => sessions.setMode(ui.modeSelect.value);
  void sessions.detect();
  function resize() {
    const rect = ui.canvas.getBoundingClientRect();
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height, false);
    camera.fov = rect.width < 700 ? 60 : 48;
    if (rect.width < 700)
      camera.setViewOffset(
        rect.width,
        rect.height,
        0,
        -rect.height * 0.14,
        rect.width,
        rect.height,
      );
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize, { signal: abort.signal });
  resize();
  desktopInput();
  ui.canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      void sessions.exit();
      ui.error('The graphics context was lost. Reload this page to resume.');
      renderer.setAnimationLoop(null);
    },
    { signal: abort.signal },
  );
  let lastTime = 0;
  renderer.setAnimationLoop((time, frame) => {
    if (destroyed) return;
    const dt = Math.min(Math.max((time - lastTime) / 1000, 0), 0.05);
    lastTime = time;
    if (renderer.xr.isPresenting && sessions.state().visible) {
      frameCount++;
      frameWindow += dt;
      if (frameWindow > 1) {
        fps = Math.round(frameCount / frameWindow);
        frameCount = 0;
        frameWindow = 0;
      }
      panels.prepare(
        renderer.xr.getCamera(),
        frame,
        renderer.xr.getReferenceSpace(),
        rig,
      );
      toolkit.update(time / 1000);
      placement.update(frame, renderer.xr.getReferenceSpace());
      panels.collision.refresh(panels.panels);
      panels.updateHover();
      panels.update(dt);
    }
    renderer.render(scene, camera);
  });
  heartbeat = setInterval(() => {
    if (document.hidden || !sessions.state().visible) return;
    data.tick();
    ui.feeds(data.states);
    updateInfo();
    if (tab === 'tools') controlsPanel.setContent(controlContent());
    ui.root.querySelector('#spatial-clock').textContent =
      new Date().toISOString().slice(11, 19) + ' UTC';
  }, 5000);
  data.toggle('earthquakes');
} catch (error) {
  console.error('Spatial startup failed', error);
  ui.error(error.message);
  data?.destroy();
  renderer?.setAnimationLoop(null);
}

const application = {
  getState: () => ({
    status: destroyed
      ? 'destroyed'
      : renderer && globe && sessions
        ? 'ready'
        : 'failed',
    view: 'spatial',
    session: sessions?.state(),
    layers: data?.states,
  }),
  async destroy() {
    if (destroyed) return;
    destroyed = true;
    clearInterval(heartbeat);
    data?.destroy();
    await sessions?.destroy();
    abort.abort();
    renderer?.setAnimationLoop(null);
    panels?.dispose();
    placement?.stop();
    globe?.dispose();
    ui.destroy();
    scene.traverse((object) => {
      object.geometry?.dispose();
      if (object.material) object.material.dispose();
    });
    renderer?.dispose();
  },
};
if (import.meta.env.DEV)
  window.__GEV_SPATIAL__ = {
    application,
    globe,
    data,
    sessions,
    panels,
    action,
    renderer,
    inspect,
  };
export { application };
