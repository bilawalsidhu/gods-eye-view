import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/** Presentation only. The agent session and account controller remain owners;
 * panel availability/collapse and the page locale stay in their existing stores.
 * No credentials, reasoning or second conversation history enter this store. */
export const useAgentConsoleStore = defineStore('gev-agent-console', () => {
  const view = shallowRef(null);
  const chatgpt = shallowRef(null);
  function publish(next) {
    view.value = next && markRaw(next);
  }
  function publishChatgpt(next) {
    chatgpt.value = next && markRaw(next);
  }
  return { view, chatgpt, publish, publishChatgpt };
});
