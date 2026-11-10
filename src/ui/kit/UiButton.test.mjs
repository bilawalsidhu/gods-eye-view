import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let vue;
let renderToString;
let UiButton;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  vue = await import('vue');
  ({ renderToString } = await import('vue/server-renderer'));
  UiButton = (await import('./UiButton.vue')).default;
});
after(() => uninstall());

function mountButton(props = {}, attrs = {}) {
  return mount(UiButton, {
    attachTo: document.body,
    props,
    attrs,
    slots: { default: 'Go' },
  });
}

test('a pressed toggle carries aria-pressed, the kit class and Core’s', async () => {
  const wrapper = mountButton(
    { pressed: false, pressedClass: 'active' },
    { id: 'go', class: 'pp-toggle-btn' },
  );
  const button = wrapper.get('button');
  assert.equal(button.attributes('aria-pressed'), 'false');
  assert.equal(button.classes().includes('active'), false);
  await wrapper.setProps({ pressed: true });
  assert.equal(button.attributes('aria-pressed'), 'true');
  assert.ok(button.classes().includes('active'));
  assert.ok(button.classes().includes('ui-button--pressed'));
  assert.ok(button.classes().includes('pp-toggle-btn'));
  assert.equal(button.attributes('type'), 'button');
  wrapper.unmount();
});

test('no aria-pressed unless pressed is passed', () => {
  const wrapper = mountButton();
  assert.equal(wrapper.get('button').attributes('aria-pressed'), undefined);
  wrapper.unmount();
});

test('a class other code adds survives a press', async () => {
  const wrapper = mountButton({ pressed: false, pressedClass: 'active' });
  const button = wrapper.get('button').element;
  button.classList.add('voice-highlight');
  await wrapper.setProps({ pressed: true });
  await wrapper.setProps({ pressed: false });
  assert.ok(button.classList.contains('voice-highlight'));
  assert.equal(button.classList.contains('active'), false);
  wrapper.unmount();
});

test('a caller’s class change keeps the pressed classes', async () => {
  const wrapper = mountButton(
    { pressed: true, pressedClass: 'active' },
    { class: { panoptic: false } },
  );
  await wrapper.setProps({ class: { panoptic: true } });
  const classes = wrapper.get('button').classes();
  assert.ok(classes.includes('panoptic'));
  assert.ok(classes.includes('active'));
  assert.ok(classes.includes('ui-button--pressed'));
  wrapper.unmount();
});

test('a renamed pressedClass leaves the button', async () => {
  const wrapper = mountButton({ pressed: true, pressedClass: 'active' });
  await wrapper.setProps({ pressedClass: 'selected' });
  let classes = wrapper.get('button').classes();
  assert.equal(classes.includes('active'), false);
  assert.ok(classes.includes('selected'));
  await wrapper.setProps({ pressed: false });
  classes = wrapper.get('button').classes();
  assert.equal(classes.includes('selected'), false);
  assert.equal(classes.includes('active'), false);
  wrapper.unmount();
});

test('server-rendered markup carries the pressed classes', async () => {
  const { createSSRApp, h } = vue;
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(
          UiButton,
          { id: 'fm', pressed: true, pressedClass: 'active' },
          () => 'FM',
        ),
    }),
  );
  assert.match(html, /<button[^>]*class="[^"]*\bactive\b[^"]*"/);
  assert.match(html, /aria-pressed="true"/);
});
