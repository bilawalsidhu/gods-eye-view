import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

export const useContextStore = defineStore('gev-context', () => {
  // A newer tab choice takes precedence over an OPEN still waiting for a photo.
  const inspectorTab = shallowRef('inspect');
  const tabRevision = shallowRef(0);
  function setInspectorTab(tab) {
    if (inspectorTab.value !== tab) tabRevision.value++;
    inspectorTab.value = tab;
  }

  return { inspectorTab, tabRevision, setInspectorTab };
});
