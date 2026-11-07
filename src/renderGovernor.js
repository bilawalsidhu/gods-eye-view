import { sceneServicesFor } from './data/sceneServices.js';

/** Owner-keyed render demand for one scene attachment, on any globe engine. */
export function createRenderGovernor(engine) {
  const holds = new Set();
  const recentRequests = [];
  let installed = false;
  let destroyed = false;
  function applyMode() {
    if (!installed || destroyed) return;
    const continuous = holds.size > 0;
    if (engine.render.isContinuous() === continuous) return;
    engine.render.setContinuous(continuous);
    if (!continuous) engine.render.request('governor-idle');
  }
  return {
    install() {
      if (destroyed) return;
      installed = true;
      applyMode();
    },
    holdContinuousRender(ownerId) {
      if (destroyed || !ownerId) return;
      holds.add(ownerId);
      applyMode();
    },
    releaseContinuousRender(ownerId) {
      if (destroyed || !ownerId) return;
      holds.delete(ownerId);
      applyMode();
    },
    governorRequestRender(reason = 'unspecified') {
      if (!installed || destroyed) return;
      if (holds.size === 0) {
        recentRequests.push({ reason, at: Date.now() });
        if (recentRequests.length > 16) recentRequests.shift();
      }
      engine.render.request(reason);
    },
    getRenderGovernorDiagnostics() {
      return {
        installed,
        mode: holds.size > 0 ? 'continuous' : 'idle',
        holds: [...holds].sort(),
        recentRequests: [...recentRequests],
      };
    },
    destroy() {
      if (destroyed) return;
      holds.clear();
      applyMode();
      installed = false;
      destroyed = true;
      recentRequests.length = 0;
    },
  };
}

/** Portable callers resolve the same governor exposed as scene.services.render. */
export function renderGovernorFor(engine) {
  return sceneServicesFor(engine)?.render ?? null;
}

export function holdContinuousRender(ownerId, engine) {
  renderGovernorFor(engine)?.holdContinuousRender(ownerId);
}

export function releaseContinuousRender(ownerId, engine) {
  renderGovernorFor(engine)?.releaseContinuousRender(ownerId);
}

export function governorRequestRender(reason, engine) {
  renderGovernorFor(engine)?.governorRequestRender(reason);
}

export function getRenderGovernorDiagnostics(engine) {
  return (
    renderGovernorFor(engine)?.getRenderGovernorDiagnostics() ?? {
      installed: false,
      mode: 'idle',
      holds: [],
      recentRequests: [],
    }
  );
}
