<script setup>
import { computed } from 'vue';
import {
  LINK_SCHEMES,
  LOGO_SCHEMES,
  safeUrl,
  splitLink,
} from '../../render/creditMarkup.js';

// One credit: its logo or its text, linked when it has a link. A credit is
// plain data (`src/render/contract/credits.d.ts`): its text is set as text,
// and a link or logo is kept only for a safe scheme.
const props = defineProps({
  credit: { type: Object, required: true },
});

const href = computed(() =>
  props.credit.href ? safeUrl(props.credit.href, LINK_SCHEMES) : null,
);
// A logo is drawn in place of the text, which names it (its alt text).
const logo = computed(() =>
  props.credit.logoUrl ? safeUrl(props.credit.logoUrl, LOGO_SCHEMES) : null,
);
// Only the credit's linked words are the link, as the source wrote it.
const parts = computed(() =>
  href.value && !logo.value && props.credit.linkText
    ? splitLink(props.credit)
    : null,
);
</script>

<template>
  <span v-if="parts" class="gev-credit"
    >{{ parts[0]
    }}<a :href="href" target="_blank" rel="noopener noreferrer">{{
      parts[1]
    }}</a
    >{{ parts[2] }}</span
  ><component
    :is="href ? 'a' : 'span'"
    v-else
    class="gev-credit"
    :href="href || undefined"
    :target="href ? '_blank' : undefined"
    :rel="href ? 'noopener noreferrer' : undefined"
    ><img
      v-if="logo"
      class="gev-credit-logo"
      :src="logo"
      :alt="credit.text"
    /><template v-else>{{ credit.text }}</template></component
  >
</template>
