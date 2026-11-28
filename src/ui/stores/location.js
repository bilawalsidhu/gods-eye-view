import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * The preset places' controls as the Omnibar and the scene chrome render
 * them. LocationControls presents whose landmarks are shown, the place
 * lookup's error and whether it runs, and the ORBIT indicator, and
 * publishes them here.
 */
export const useLocationStore = defineStore('gev-location', () => {
  /** The presented controls; null until they first render. */
  const [view, publish] = presented();

  /** The controls whose `chooseCity(id)` and `choosePoi(index)` the Omnibar's chips call. */
  const [controls, connect] = presented();

  return { view, publish, controls, connect };
});
