import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, ref, Teleport } from 'vue';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { createPortalTargets } from './portalTargets.js';
import { usePortalTargetsStore } from './stores/portalTargets.js';
import PortalSlot from './views/panels/PortalSlot.vue';
import { usePortalSource } from './views/panels/usePortalSource.js';

test('withdrawal restores the prior offer and expires dropped focus and fallback', async () => {
  const portal = createPortalTargets();
  const slot = document.createElement('div');
  const alternate = document.createElement('div');
  const button = slot.appendChild(document.createElement('button'));
  document.body.append(slot, alternate);
  try {
    const first = portal.offer('panel', alternate);
    const recent = portal.offer('panel', slot, { fallback: () => button });
    assertSameNode(portal.target('panel'), slot);
    button.focus();
    portal.withdraw(recent);
    assertSameNode(portal.target('panel'), alternate);
    assertSameNode(portal.takeDropped('panel'), button);
    assert.equal(portal.takeDropped('panel'), null);
    assertSameNode(portal.fallbackOf('panel'), button);
    await Promise.resolve();
    assert.equal(portal.fallbackOf('panel'), null);
    portal.withdraw(first);
    assert.equal(portal.target('panel'), null);
  } finally {
    slot.remove();
    alternate.remove();
  }
});

function mountPortal(t) {
  const pinia = createPinia();
  const portal = usePortalTargetsStore(pinia);
  const host = document.body.appendChild(document.createElement('div'));
  const shown = ref(false);
  const embed = ref(false);
  const slot = ref('first-slot');
  const app = createApp({
    setup() {
      const control = ref(null);
      const { to, disabled } = usePortalSource(
        portal,
        control,
        () => {
          if (embed.value) return { el: document.body };
          const target = portal.target('panel');
          return target ? { name: 'panel', el: target } : null;
        },
        { fallback: () => document.getElementById('portal-fallback') },
      );
      return () => [
        slot.value &&
          h(PortalSlot, {
            portal,
            name: 'panel',
            key: slot.value,
            id: slot.value,
            shown: () => shown.value,
          }),
        h('div', { id: 'portal-home' }, [
          h(Teleport, { to: to.value, disabled: disabled.value }, [
            h('input', { ref: control, id: 'portal-control' }),
          ]),
        ]),
        h('button', { id: 'portal-fallback' }),
      ];
    },
  });
  app.use(pinia).mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  return { portal, shown, embed, slot };
}

test('one mounted control survives home, slot replacement and embed', async (t) => {
  const { portal, shown, embed, slot } = mountPortal(t);
  const control = document.getElementById('portal-control');
  const check = async (id) => {
    await nextTick();
    assertSameNode(document.getElementById('portal-control'), control);
    assert.equal(control.parentElement.id, id);
    assert.ok(control.isConnected);
  };
  control.value = 'typed before the move';
  await check('portal-home');
  shown.value = true;
  await check('first-slot');
  assert.equal(usePortalTargetsStore(createPinia()).target('panel'), null);
  slot.value = 'second-slot';
  await check('second-slot');
  embed.value = true;
  await nextTick();
  assertSameNode(control.parentElement, document.body);
  shown.value = false;
  embed.value = false;
  await check('portal-home');
  embed.value = true;
  await nextTick();
  assertSameNode(control.parentElement, document.body);
  embed.value = false;
  shown.value = true;
  await check('second-slot');
  slot.value = null;
  await check('portal-home');
  assert.equal(portal.target('panel'), null);
  assert.equal(control.value, 'typed before the move');
});

test('a moved control that becomes hidden hands lost focus to its source fallback', async (t) => {
  const { shown } = mountPortal(t);
  shown.value = true;
  await nextTick();
  const control = document.getElementById('portal-control');
  const home = document.getElementById('portal-home');
  const fallback = document.getElementById('portal-fallback');
  control.checkVisibility = () => false;
  fallback.checkVisibility = () => true;
  const insert = home.insertBefore.bind(home);
  t.mock.method(home, 'insertBefore', (node, anchor) => {
    const added = insert(node, anchor);
    if (node === control) control.blur();
    return added;
  });
  control.focus();
  assertSameNode(document.activeElement, control);
  shown.value = false;
  await nextTick();
  await nextTick();
  assertSameNode(control.parentElement, home);
  assertSameNode(document.activeElement, fallback);
});

test('portal focus repair respects a control that redirects restored focus', async (t) => {
  const { shown } = mountPortal(t);
  shown.value = true;
  await nextTick();
  const control = document.getElementById('portal-control');
  const home = document.getElementById('portal-home');
  const fallback = document.getElementById('portal-fallback');
  const other = document.body.appendChild(document.createElement('button'));
  t.after(() => other.remove());
  control.checkVisibility = fallback.checkVisibility = () => true;
  const insert = home.insertBefore.bind(home);
  t.mock.method(home, 'insertBefore', (node, anchor) => {
    const result = insert(node, anchor);
    if (node === control) control.blur();
    return result;
  });
  control.focus();
  control.addEventListener('focus', () => other.focus(), { once: true });

  shown.value = false;
  await nextTick();
  await nextTick();
  assertSameNode(document.activeElement, other);
});
