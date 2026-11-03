<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { cloud, unwrap, validateSavedView } from './cloud.js';
import * as Cesium from 'cesium';
const props = defineProps({
  viewer: Object,
  navigation: Object,
  session: Object,
  filters: Object,
});
const emit = defineEmits(['session', 'status']);
const email = ref(''),
  password = ref(''),
  mode = ref('signin'),
  busy = ref(false),
  message = ref(''),
  views = ref([]),
  name = ref(''),
  recovery = ref(false);
let subscription;
let viewVersion = 0;
let authVersion = 0;
let disposed = false;
async function run(action) {
  busy.value = true;
  message.value = '';
  try {
    await action();
  } catch (e) {
    message.value = e.message || 'Account request failed. Try again.';
  } finally {
    busy.value = false;
  }
}
async function loadViews() {
  const version = ++viewVersion;
  const userId = props.session?.user.id;
  views.value = [];
  if (!userId || !cloud) return;
  try {
    const rows = await unwrap(
      cloud
        .from('saved_views')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100),
    );
    if (
      !disposed &&
      version === viewVersion &&
      props.session?.user.id === userId
    )
      views.value = rows;
  } catch (error) {
    if (!disposed && version === viewVersion) message.value = error.message;
  }
}
onMounted(async () => {
  if (!cloud) return;
  subscription = cloud.auth.onAuthStateChange((event, session) => {
    ++authVersion;
    emit('session', session);
    if (event === 'PASSWORD_RECOVERY') {
      recovery.value = true;
      mode.value = 'password';
    }
  }).data.subscription;
  const version = authVersion;
  await run(async () => {
    const { data, error } = await cloud.auth.getSession();
    if (error) throw error;
    if (!disposed && version === authVersion) emit('session', data.session);
  });
});
watch(() => props.session?.user.id, loadViews, { immediate: true });
onBeforeUnmount(() => {
  disposed = true;
  ++viewVersion;
  subscription?.unsubscribe();
});
async function submit() {
  await run(async () => {
    const redirectTo = new URL('/', location.href).href;
    if (mode.value === 'recover') {
      await unwrap(
        cloud.auth.resetPasswordForEmail(email.value, { redirectTo }),
      );
      message.value =
        'If the account exists, a recovery email will arrive. Open it in this browser.';
    } else if (mode.value === 'password') {
      await unwrap(cloud.auth.updateUser({ password: password.value }));
      recovery.value = false;
      mode.value = 'signin';
      message.value = 'Password updated.';
    } else if (mode.value === 'signup') {
      await unwrap(
        cloud.auth.signUp({
          email: email.value,
          password: password.value,
          options: { emailRedirectTo: redirectTo },
        }),
      );
      message.value =
        'Check your email to confirm your account. Open the link in this browser.';
    } else
      await unwrap(
        cloud.auth.signInWithPassword({
          email: email.value,
          password: password.value,
        }),
      );
  });
}
async function saveView() {
  await run(async () => {
    const camera = props.viewer.camera,
      p = Cesium.Cartographic.fromCartesian(camera.positionWC);
    const value = {
      name: name.value.trim(),
      longitude: Cesium.Math.toDegrees(p.longitude),
      latitude: Cesium.Math.toDegrees(p.latitude),
      height: p.height,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
      filters: props.filters,
    };
    if (!validateSavedView(value))
      throw Error('Move the camera above the Earth before saving.');
    await unwrap(cloud.from('saved_views').insert(value));
    name.value = '';
    await loadViews();
    message.value = 'View and filters saved to your account.';
  });
}
function restore(view) {
  if (!validateSavedView(view)) {
    message.value = 'This view has invalid coordinates.';
    return;
  }
  const accepted = props.navigation.runImmediateNavigation('location', () =>
    props.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        view.longitude,
        view.latitude,
        view.height,
      ),
      orientation: {
        heading: view.heading,
        pitch: view.pitch,
        roll: view.roll,
      },
      duration: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
        .matches
        ? 0
        : 1.4,
    }),
  );
  if (accepted === false) {
    message.value = 'Finish the current navigation before restoring this view.';
    return;
  }
  emit('status', { filters: view.filters });
  message.value = 'Saved view restored.';
}
</script>
<template>
  <section class="mz-account" aria-label="Your account">
    <h3>Your MzansiView</h3>
    <p v-if="!cloud"
      >Cloud accounts are unavailable in this build. Browser favourites still
      work.</p
    >
    <template v-else>
      <template v-if="session && !recovery">
        <p>Signed in as {{ session.user.email }}</p>
        <button
          :disabled="busy"
          @click="
            run(async () => {
              await unwrap(cloud.auth.signOut());
              views = [];
              message = 'Signed out.';
            })
          "
          >Sign out</button
        >
        <form @submit.prevent="saveView"
          ><label
            >View name<input
              v-model="name"
              required
              maxlength="100"
              placeholder="My Durban view" /></label
          ><button :disabled="busy">Save current view</button></form
        >
        <p v-if="!views.length">No cloud views saved yet.</p>
        <ul
          ><li v-for="view in views" :key="view.id"
            ><button @click="restore(view)">{{ view.name }}</button
            ><button
              :disabled="busy"
              :aria-label="`Delete ${view.name}`"
              @click="
                run(async () => {
                  await unwrap(
                    cloud.from('saved_views').delete().eq('id', view.id),
                  );
                  await loadViews();
                })
              "
              >Delete</button
            ></li
          ></ul
        >
      </template>
      <template v-else>
        <form @submit.prevent="submit">
          <label v-if="mode !== 'password'"
            >Email<input
              v-model="email"
              required
              type="email"
              autocomplete="email"
          /></label>
          <label v-if="mode !== 'recover'"
            >{{ mode === 'password' ? 'New password' : 'Password'
            }}<input
              v-model="password"
              required
              type="password"
              minlength="8"
              :autocomplete="
                mode === 'signin' ? 'current-password' : 'new-password'
              "
          /></label>
          <button :disabled="busy">{{
            {
              signin: 'Sign in',
              signup: 'Create account',
              recover: 'Send recovery email',
              password: 'Update password',
            }[mode]
          }}</button>
        </form>
        <div class="mz-account-modes"
          ><button @click="mode = 'signin'">Sign in</button
          ><button @click="mode = 'signup'">Create account</button
          ><button @click="mode = 'recover'">Forgot password</button></div
        >
      </template>
    </template>
    <p v-if="busy" role="status">Working…</p
    ><p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
