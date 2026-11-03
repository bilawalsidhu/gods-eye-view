<script setup>
import { onMounted, ref } from 'vue';
import { cloud, unwrap } from './cloud.js';
const allowed = ref(false),
  rows = ref([]),
  runs = ref([]),
  busy = ref(false),
  message = ref('');
async function run(action) {
  busy.value = true;
  message.value = '';
  try {
    await action();
  } catch (e) {
    message.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  rows.value = await unwrap(
    cloud
      .from('places')
      .select('*')
      .eq('published', false)
      .order('observed_at', { ascending: false })
      .limit(200),
  );
  runs.value = await unwrap(cloud.rpc('admin_import_runs'));
}
onMounted(() =>
  run(async () => {
    allowed.value = await unwrap(cloud.rpc('is_mzansi_admin'));
    if (allowed.value) await refresh();
  }),
);
async function publish(row) {
  await run(async () => {
    await unwrap(
      cloud
        .from('places')
        .update({ published: true, reviewed_at: new Date().toISOString() })
        .eq('id', row.id),
    );
    await refresh();
    message.value = 'Published after review.';
  });
}
async function importPlaces() {
  await run(async () => {
    await unwrap(cloud.functions.invoke('import-durban'));
    await refresh();
    message.value =
      'Import complete. Review coordinates, source and category before publishing.';
  });
}
</script>
<template>
  <section v-if="allowed" class="mz-account" aria-label="Administration"
    ><h3>Import review</h3
    ><p
      >Durban public facilities · OpenStreetMap / ODbL. Imports are drafts.
      Maximum 200 records, 15-minute cooldown.</p
    ><button :disabled="busy" @click="importPlaces"
      >Import Durban facilities</button
    ><button :disabled="busy" @click="run(refresh)">Refresh</button
    ><p role="status">{{ busy ? 'Working…' : message }}</p
    ><p v-if="!rows.length">No pending places.</p
    ><article v-for="row in rows" :key="row.id"
      ><h4>{{ row.name }}</h4
      ><p>{{ row.category }} · {{ row.latitude }}, {{ row.longitude }}</p
      ><a :href="row.source_url" target="_blank" rel="noopener noreferrer"
        >Review source</a
      ><button :disabled="busy" @click="publish(row)"
        >Publish reviewed place</button
      ><button
        :disabled="busy"
        @click="
          run(async () => {
            await unwrap(cloud.from('places').delete().eq('id', row.id));
            await refresh();
          })
        "
        >Reject</button
      ></article
    ><h4>Recent imports</h4
    ><ul
      ><li v-for="item in runs" :key="item.id"
        >{{ item.started_at }} · {{ item.status }} ·
        {{ item.row_count }} records {{ item.error }}</li
      ></ul
    ></section
  >
</template>
