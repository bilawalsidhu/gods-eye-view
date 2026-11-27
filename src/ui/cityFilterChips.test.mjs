import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, ref } from 'vue';
import CityFilterChips from './views/panels/CityFilterChips.vue';

function mount(t) {
  const host = document.createElement('div');
  document.body.append(host);
  const cities = ref(['Austin', 'Montréal', 'Tokyo']);
  const city = ref('');
  const app = createApp(() =>
    h(CityFilterChips, {
      cities: cities.value,
      modelValue: city.value,
      'onUpdate:modelValue': (value) => (city.value = value),
    }),
  );
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  const group = host.querySelector('[role="group"]');
  const toggle = group.querySelector('[aria-expanded]');
  const strip = document.getElementById(toggle.getAttribute('aria-controls'));
  return {
    city,
    cities,
    strip,
    group,
    toggle,
    chips: () => Array.from(strip.querySelectorAll('button')),
  };
}

test('city filter controls a single selection, including All', async (t) => {
  const { chips, city, group } = mount(t);
  const [all, , montreal] = chips();
  const selected = () =>
    chips().filter((b) => b.getAttribute('aria-pressed') === 'true');
  assert.ok(group.getAttribute('aria-label'));
  assert.deepEqual(selected(), [all]);
  montreal.click();
  await nextTick();
  assert.equal(city.value, 'Montréal');
  assert.deepEqual(selected(), [montreal]);
  all.click();
  await nextTick();
  assert.equal(city.value, '');
  assert.deepEqual(selected(), [all]);
});

test('expanding and shrinking preserves selected chips and toggle focus', async (t) => {
  const { city, chips, strip, toggle } = mount(t);
  const original = chips();
  city.value = 'Tokyo';
  toggle.focus();
  assert.equal(toggle.getAttribute('aria-controls'), strip.id);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  await nextTick();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, toggle);
  for (const [index, chip] of chips().entries())
    assert.equal(chip, original[index]);
  assert.equal(original.at(-1).getAttribute('aria-pressed'), 'true');
  toggle.click();
  await nextTick();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, toggle);
  assert.equal(original.at(-1).getAttribute('aria-pressed'), 'true');
});

test('a changing city list preserves focus or returns it to All', async (t) => {
  const { cities, chips } = mount(t);
  const [all, , , tokyo] = chips();
  tokyo.focus();
  cities.value = ['Tokyo', 'Austin', 'Montréal'];
  await nextTick();
  assert.equal(chips()[1], tokyo);
  assert.equal(document.activeElement, tokyo);
  cities.value = ['Austin', 'Montréal'];
  await nextTick();
  assert.equal(document.activeElement, all);
});
