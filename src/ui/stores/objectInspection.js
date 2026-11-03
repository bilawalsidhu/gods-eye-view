import { defineStore } from 'pinia';
import { shallowRef, ref } from 'vue';
import { createOwners } from './owners.js';

/** Live read-only details and camera-return actions for the selected map object. */
export const useObjectInspectionStore = defineStore(
  'gev-object-inspection',
  () => {
    const owners = createOwners();
    const object = shallowRef(null);
    const canReturn = ref(false);
    const error = ref('');
    function publish(next) {
      object.value = next;
    }
    function act(name) {
      error.value = '';
      try {
        return owners.act(name);
      } catch (failure) {
        error.value = failure.message;
        return false;
      }
    }
    return {
      object,
      canReturn,
      error,
      publish,
      act,
      connect: owners.connect,
      detach: owners.detach,
    };
  },
);
