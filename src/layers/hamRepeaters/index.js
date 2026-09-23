import { createState } from './state.js';
import { createPresentation } from './presentation.js';
import { createInteraction } from './interaction.js';
import { createRendering } from './rendering.js';
import { createQueries } from './queries.js';
import { createIngestion } from './ingestion.js';
import { createCamera } from './camera.js';
import { createLifecycle } from './lifecycle.js';
import { createControls } from './controls.js';

/**
 * Construct one Repeaters layer with its own scene state and supplied
 * application services.
 *
 * FM and D-STAR amateur-radio repeaters around the view, loaded from the
 * supplied source when the camera settles below the height gate (or on
 * LOAD HERE), drawn as clustered points coloured by kind. Every row carries
 * its source, confidence and record date: this is directory data, and a
 * marker's distance says nothing about whether the repeater can be reached.
 *
 * @param {{services: object, source: object}} options
 * @returns {object} The data-layer module the manager registers.
 */
export function createHamRepeatersLayer({ services, source }) {
  if (
    !services?.picking ||
    !services?.render ||
    !services?.ground ||
    !services?.context
  ) {
    throw new TypeError(
      'A repeaters layer needs picking, render, ground and context services',
    );
  }
  if (typeof source?.getRepeaters !== 'function') {
    throw new TypeError('A repeaters source needs a getRepeaters operation');
  }
  const state = createState();
  const parts = {};
  const context = { state, services, parts, source };
  parts.presentation = createPresentation(context);
  parts.interaction = createInteraction(context);
  parts.rendering = createRendering(context);
  parts.queries = createQueries(context);
  parts.ingestion = createIngestion(context);
  parts.camera = createCamera(context);
  parts.lifecycle = createLifecycle(context);
  parts.controls = createControls(context);
  return Object.assign(
    {},
    parts.lifecycle.methods,
    parts.ingestion.methods,
    parts.controls.methods,
  );
}

export { createHamRepeatersSource } from './source.js';
export { HAM_REPEATERS_LAYER_ID, REACHABILITY_NOTE } from './policy.js';
