import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/** Only presentation and handlers cross from the portable wells owner. */
export const useWellRecordsStore = defineStore('gev-well-records', () => {
  const records = shallowRef(null);
  const choices = shallowRef(null);
  const publishRecords = (next) => {
    records.value = next && markRaw(next);
  };
  const publishChoices = (next) => {
    choices.value = next && markRaw(next);
  };
  return { records, choices, publishRecords, publishChoices };
});
