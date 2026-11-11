import { EffectDesc, Pass as NavaraPass } from '@navaramap/three';
import { GeometrySamplingPass } from './postSamplingPass.js';

const KEY = 'gevPostSampling';
class PostSamplingDesc extends EffectDesc {
  static key = KEY;
  static insertBefore = ['mrt'];

  createPass() {
    return new NavaraPass(new GeometrySamplingPass(this.ctx), null);
  }
}

export function createPostSampling(view) {
  view.registerEffect(KEY, PostSamplingDesc);
  const handle = view.addEffect({ [KEY]: {}, visible: true });
  return () => handle.delete();
}
