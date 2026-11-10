/** Observe a started engine without importing runtime or SDK modules. */
export function createContractMonitor(engine, report = () => {}) {
  const records = [];
  const flights = [];
  const removers = [];
  const restorers = [];
  let destroyed = false;
  let moving = false;
  let frame = 0;
  let inFrame = false;
  let requestedInFrame = null;
  const record = (invariant, detail = {}) => {
    const row = { invariant, frame, ...detail };
    records.push(row);
    report(row);
  };
  const wrap = (owner, name, decorate) => {
    const original = owner[name];
    const wrapped = decorate(original);
    owner[name] = wrapped;
    restorers.push(() => {
      if (owner[name] === wrapped) owner[name] = original;
    });
  };
  const listen = (event, name, callback = () => {}) => {
    if (!event) return;
    removers.push(
      event.addEventListener(() => {
        if (destroyed) record('event-after-destroy', { event: name });
        else callback();
      }),
    );
  };
  for (const name of ['changed', 'commanded', 'followChanged'])
    listen(engine.camera[name], `camera.${name}`);
  listen(engine.camera.moveStart, 'camera.moveStart', () => {
    if (moving) record('move-alternation', { event: 'moveStart' });
    moving = true;
  });
  listen(engine.camera.moveEnd, 'camera.moveEnd', () => {
    if (!moving) record('move-alternation', { event: 'moveEnd' });
    moving = false;
  });
  listen(engine.frames.preUpdate, 'frames.preUpdate', () => {
    frame++;
    inFrame = true;
    // Request-mode engines can update without drawing a frame.
    queueMicrotask(() => {
      inFrame = false;
    });
  });
  listen(engine.frames.preRender, 'frames.preRender', () => {
    inFrame = true;
  });
  listen(engine.frames.postRender, 'frames.postRender', () => {
    if (requestedInFrame !== null && frame > requestedInFrame)
      requestedInFrame = null;
    // Include requests made by listeners registered after the monitor.
    queueMicrotask(() => {
      inFrame = false;
    });
  });
  listen(engine.maps.errors, 'maps.errors');
  for (const type of ['click', 'doubleClick', 'move', 'down', 'up']) {
    removers.push(
      engine.input.on(type, () => {
        if (destroyed)
          record('event-after-destroy', { event: `input.${type}` });
      }),
    );
  }
  wrap(
    engine.render,
    'request',
    (original) =>
      function (...args) {
        if (inFrame) requestedInFrame = frame;
        return original.apply(this, args);
      },
  );
  const missing = () => {
    for (const flight of flights) {
      if (!flight.ends && !flight.reported) {
        flight.reported = true;
        record('flight-terminal', { flight: flight.id, ends: 0 });
      }
    }
  };
  for (const name of ['flyTo', 'flyToSphere']) {
    wrap(
      engine.camera,
      name,
      (original) =>
        function (...args) {
          const index = name === 'flyTo' ? 0 : 1;
          const options = args[index] ?? {};
          const flight = { id: flights.length + 1, ends: 0 };
          flights.push(flight);
          const observed = { ...options };
          for (const outcome of ['complete', 'cancel']) {
            observed[outcome] = function (...values) {
              flight.ends++;
              if (flight.ends !== 1)
                record('flight-terminal', {
                  flight: flight.id,
                  ends: flight.ends,
                  outcome,
                });
              if (outcome === 'complete' && engine.camera.flightActive())
                record('flight-active', { flight: flight.id, at: 'complete' });
              return options[outcome]?.apply(this, values);
            };
          }
          args[index] = observed;
          try {
            return original.apply(this, args);
          } catch (error) {
            // Invalid commands do not promise a flight or a terminal callback.
            flights.splice(flights.indexOf(flight), 1);
            throw error;
          }
        },
    );
  }
  for (const name of ['cancelFlight', 'completeFlight']) {
    wrap(
      engine.camera,
      name,
      (original) =>
        function (...args) {
          const result = original.apply(this, args);
          if (engine.camera.flightActive())
            record('flight-active', { at: name });
          missing();
          return result;
        },
    );
  }
  wrap(
    engine,
    'destroy',
    (original) =>
      function (...args) {
        const result = original.apply(this, args);
        destroyed = true;
        inFrame = false;
        requestedInFrame = null;
        missing();
        return result;
      },
  );
  return {
    records,
    async finish({ active = true } = {}) {
      missing();
      if (!destroyed && active) {
        if (!engine.input.cameraInputsEnabled())
          record('final-inputs-disabled');
        if (engine.camera.flightActive()) record('final-flight-active');
        if (requestedInFrame !== null) {
          const requested = requestedInFrame;
          // A request on the last observed frame still deserves its next frame.
          await new Promise((resolve) => {
            const remove = engine.frames.postRender.addEventListener(() => {
              if (frame <= requested) return;
              clearTimeout(timer);
              remove();
              resolve();
            });
            const timer = setTimeout(() => {
              remove();
              if (!destroyed)
                record('render-request-lost', { requestedInFrame: requested });
              resolve();
            }, 2000);
          });
        }
      }
      return records;
    },
    dispose() {
      for (const remove of removers) remove();
      for (const restore of restorers.reverse()) restore();
    },
  };
}
