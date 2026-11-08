// Navara auto-binds descriptor.update on creation but does not unregister
// that bound function when its handle is deleted. GEV's synchronous effects
// and meshes subscribe with their own callback so a parked view can be reused.
export function withFrameUpdates(Base) {
  return class extends Base {
    #frame = (time) => this.updateFrame(time);

    onCreate() {
      super.onCreate();
      this.view.on('preRender', this.#frame);
    }

    onDestroy() {
      this.view.off('preRender', this.#frame);
      super.onDestroy();
    }
  };
}

// Navara's EffectDesc.onDestroy takes its pass out of the composer, and
// EffectComposer.removePass does not dispose it: the pass's render targets,
// materials and shader programs would stay on the GPU for every effect
// added and deleted. A GEV effect disposes its own raw pass once removed.
export function withPassDisposal(Base) {
  return class extends Base {
    onDestroy() {
      const pass = this.raw?.rawPass;
      try {
        super.onDestroy();
      } finally {
        pass?.dispose();
      }
    }
  };
}
