import { createStateChannel } from './app/stateChannel.js';

const OFF_STATE = Object.freeze({
  enabled: false,
  status: 'off',
  message: '',
  errorCode: null,
  position: null,
});

let state = { ...OFF_STATE };
const channel = createStateChannel(() => state);

export function readMyLocationState() {
  return state;
}

export function publishMyLocationState(nextState, change = null) {
  state = {
    ...OFF_STATE,
    ...nextState,
    position: nextState?.position ? { ...nextState.position } : null,
  };
  channel.publish(change);
  return state;
}

export function subscribeMyLocationState(listener, options) {
  return channel.subscribe(listener, options);
}

export function resetMyLocationState(change = { type: 'reset' }) {
  return publishMyLocationState(OFF_STATE, change);
}
