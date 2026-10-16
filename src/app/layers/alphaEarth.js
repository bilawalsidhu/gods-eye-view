import { createAlphaEarthLayer } from '../../layers/alphaEarth/index.js';
import { createAlphaEarthRenderer } from '../../layers/alphaEarth/rendering.js';
import { governorRequestRender } from '../../renderGovernor.js';

/** Construct the change layer over one explicitly supplied embedding source. */
export function createApplicationAlphaEarth({ source }) {
  return createAlphaEarthLayer({
    source: {
      listYears: (...args) => source.listYears(...args),
      fetchChange: (...args) => source.fetchChange(...args),
    },
    renderer: createAlphaEarthRenderer({
      requestRender: governorRequestRender,
      credit: source.credit || 'AlphaEarth Foundations',
    }),
  });
}
