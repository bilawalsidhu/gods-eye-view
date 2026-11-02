import { applicationPinia } from './vueRuntime.js';
import { useWellRecordsStore } from './stores/wellRecords.js';

/** Application-owned Vue bridge; the exported layer has no framework dependency. */
export function createWellRecordUi() {
  const store = useWellRecordsStore(applicationPinia());
  let generation = 0;
  return {
    publishRecords: (view) => store.publishRecords(view),
    publishChoices: (view) =>
      store.publishChoices(view && { ...view, id: ++generation }),
  };
}
