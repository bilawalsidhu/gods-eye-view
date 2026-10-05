import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {createGlassWorkspace,MAX_HANDS} from '../src/workspace.js';

// The shader itself needs a GL context, so these cover the part that runs on the CPU: turning
// world-space hands into the surface-plane coordinates the fragment shader samples.
const root=(position=[0,0,0],scale=1)=>{const g=new THREE.Group();g.position.set(...position);g.scale.setScalar(scale);g.updateMatrixWorld(true);return g};
const hands=workspace=>workspace.material.uniforms.uHands.value;

test('the sheet is sized from its options and lies flat', () => {
  const workspace=createGlassWorkspace({width:2,depth:3});
  assert.equal(workspace.material.uniforms.uHalf.value.x, 1);
  assert.equal(workspace.material.uniforms.uHalf.value.y, 1.5);
  assert.ok(Math.abs(workspace.mesh.rotation.x + Math.PI/2) < 1e-9, 'the plane faces up');
});

test('a hand maps into the surface plane, with height kept separate', () => {
  const workspace=createGlassWorkspace({width:1,depth:1}),parent=root([0,.8,-2]);
  // 0.2 right of centre, 0.3 nearer the viewer, 0.05 above the surface.
  workspace.setHands([new THREE.Vector3(.2,.85,-1.7)],parent);
  const h=hands(workspace)[0];
  assert.ok(Math.abs(h.x-.2)<1e-6);
  assert.ok(Math.abs(h.y-.05)<1e-6,'y stays the height above the sheet');
  assert.ok(Math.abs(h.z+.3)<1e-6,'the plane runs along -z, so z is negated');
});

test('a missing hand is parked below the surface rather than glowing at the origin', () => {
  const workspace=createGlassWorkspace(),parent=root();
  workspace.setHands([new THREE.Vector3(0,.02,0)],parent);
  assert.ok(hands(workspace)[0].y > -.5, 'the tracked hand is live');
  assert.equal(hands(workspace)[1].y, -1, 'the untracked hand is parked');
  workspace.setHands([],parent);
  assert.equal(hands(workspace)[0].y, -1, 'dropping tracking parks the hand again');
  workspace.setHands(null,parent);
  assert.equal(hands(workspace)[0].y, -1, 'no input at all is not an error');
});

test('more hands than the shader has slots are ignored, not overflowed', () => {
  const workspace=createGlassWorkspace(),parent=root();
  const points=Array.from({length:MAX_HANDS+3},(_,i)=>new THREE.Vector3(i*.01,.02,0));
  workspace.setHands(points,parent);
  assert.equal(hands(workspace).length, MAX_HANDS);
});

test('a scaled surface keeps the halo hand-sized instead of shrinking it', () => {
  const workspace=createGlassWorkspace(),full=root([0,0,0],1),half=root([0,0,0],.5);
  workspace.setHands([new THREE.Vector3(0,.02,0)],full);
  const atFull=workspace.material.uniforms.uHandRadius.value;
  workspace.setHands([new THREE.Vector3(0,.02,0)],half);
  assert.ok(Math.abs(workspace.material.uniforms.uHandRadius.value-atFull*2)<1e-9,
    'local radius doubles when the surface is half size, so it covers the same real distance');
});
