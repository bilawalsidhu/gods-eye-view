import test from 'node:test';
import assert from 'node:assert/strict';
import { railFixture } from './railTestFixture.mjs';
import { syncRowForm } from './rowForm.js';

test('poll refreshes retain focused drafts and selection; actions read current values; explicit clear resets inputs', () => {
  const f = railFixture();
  const bind = (element, type, fn) => element.addEventListener(type, fn);
  const calls = [];
  const descriptor = {
    revision: 0,
    fields: [
      { id: 'airline', label: 'Airline', value: '' },
      {
        id: 'selected',
        label: 'Flights',
        value: '',
        options: [
          { value: '', label: 'Choose' },
          { value: 'abc123', label: 'BAW123' },
        ],
      },
    ],
    actions: [
      { id: 'apply', label: 'Apply', onClick: (values) => calls.push(values) },
    ],
  };
  syncRowForm(f.container, descriptor, bind);
  const input = f.container._fields.get('airline').control;
  const select = f.container._fields.get('selected').control;
  input.value = 'BA';
  input.focus();
  select.value = 'abc123';
  syncRowForm(
    f.container,
    {
      ...descriptor,
      fields: [
        descriptor.fields[0],
        {
          ...descriptor.fields[1],
          options: [
            ...descriptor.fields[1].options,
            { value: 'abc124', label: 'BAW124' },
          ],
        },
      ],
    },
    bind,
  );
  assert.equal(f.document.activeElement, input);
  assert.equal(input.value, 'BA');
  assert.equal(select.value, 'abc123');
  f.container._actions.get('apply').click();
  assert.deepEqual(calls, [{ airline: 'BA', selected: 'abc123' }]);
  syncRowForm(f.container, { ...descriptor, revision: 1 }, bind);
  assert.equal(input.value, '');
  assert.equal(select.value, '');
});

test('hidden and disabled forms cannot invoke actions and Enter submits through the current descriptor', () => {
  const f = railFixture();
  let calls = 0;
  const descriptor = {
    revision: 0,
    fields: [{ id: 'flight', label: 'Flight', value: '' }],
    actions: [{ id: 'apply', label: 'Apply', onClick: () => calls++ }],
  };
  const bind = (element, type, fn) => element.addEventListener(type, fn);
  syncRowForm(f.container, descriptor, bind);
  const event = new Event('keydown');
  Object.defineProperty(event, 'key', { value: 'Enter' });
  f.container._fields.get('flight').control.dispatchEvent(event);
  assert.equal(calls, 1);
  syncRowForm(
    f.container,
    { ...descriptor, actions: [{ ...descriptor.actions[0], disabled: true }] },
    bind,
  );
  f.container._fields.get('flight').control.dispatchEvent(event);
  assert.equal(calls, 1);
  syncRowForm(f.container, null, bind);
  f.container._fields.get('flight').control.dispatchEvent(event);
  assert.equal(calls, 1);
});
