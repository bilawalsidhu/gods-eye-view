// src/ui/styleParameters.test.mjs — generated style-parameter rows render
// through Vue behind createStyleParameters and hand input back to the owner.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStyleParameters,
  snapToStep,
  styleParameterRows,
  withParameterValue,
} from './styleParameters.js';

function parameters(t, values = { amount: 0.25, scale: 2 }) {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const controller = createStyleParameters({ container });
  t.after(() => controller.destroy());
  const uniforms = {
    amount: { label: '<Amount>', min: 0, max: 1 },
    scale: { label: 'Scale', min: 0, max: 10 },
  };
  const order = [];
  const rowsOf = () => [...container.querySelectorAll('.param-slider-row')];
  const options = {
    uniforms,
    readValue: (name) => values[name],
    writeValue: (name, value) => {
      order.push(['write', name, value]);
      values[name] = value;
    },
    onChange: () => {
      order.push(['change', rowsOf()[0]?.children[2].textContent]);
    },
  };
  controller.render(options);
  return { container, controller, values, options, order, rowsOf };
}

const input = (slider, value) => {
  slider.value = value;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
};

test('parameter rows preserve labels, bounds, precision and initial values', (t) => {
  const f = parameters(t);
  const rows = f.rowsOf();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].childNodes.length, 3, 'no text between the parts');
  const [label, slider, value] = rows[0].children;
  assert.equal(label.className, 'param-label');
  assert.equal(label.textContent, '<Amount>');
  assert.equal(slider.getAttribute('aria-label'), '<Amount>');
  assert.equal(slider.type, 'range');
  assert.equal(slider.className, 'gev-quantitative-slider param-slider');
  assert.equal(slider.getAttribute('min'), '0');
  assert.equal(slider.getAttribute('max'), '1');
  assert.equal(slider.getAttribute('step'), '0.01');
  assert.equal(slider.hasAttribute('value'), false, 'the value is live only');
  assert.equal(slider.value, '0.25');
  assert.equal(value.className, 'param-value');
  assert.equal(value.textContent, '0.25');
  assert.equal(rows[1].children[1].getAttribute('step'), '0.1');
  assert.equal(rows[1].children[2].textContent, '2.0');
  assert.deepEqual(
    f.order,
    [],
    'rendering must not write shader values or publish changes',
  );
});

test('the readout shows the value the slider holds after clamping', (t) => {
  const f = parameters(t, { amount: 1.7, scale: -3 });
  const [amount, scale] = f.rowsOf();
  const held = (row, digits) => Number(row.children[1].value).toFixed(digits);
  assert.equal(amount.children[2].textContent, held(amount, 2));
  assert.equal(scale.children[2].textContent, held(scale, 1));
  assert.notEqual(amount.children[2].textContent, '1.70', 'not the raw value');
});

test('input writes numeric values, updates the readout, then requests a change', (t) => {
  const f = parameters(t);
  input(f.rowsOf()[0].children[1], '0.75');
  assert.equal(f.values.amount, 0.75);
  assert.deepEqual(f.order, [
    ['write', 'amount', 0.75],
    ['change', '0.75'],
  ]);
});

test('rebuilding the parameter panel revokes detached slider listeners', (t) => {
  const f = parameters(t);
  const oldSlider = f.rowsOf()[0].children[1];
  f.controller.render({
    ...f.options,
    uniforms: { scale: f.options.uniforms.scale },
  });
  input(oldSlider, '0.8');
  assert.equal(f.values.amount, 0.25);
  assert.equal(f.rowsOf().length, 1);
  input(f.rowsOf()[0].children[1], '3.5');
  assert.equal(f.values.scale, 3.5);
});

test('clearing removes rows and listeners but allows another style', (t) => {
  const f = parameters(t);
  const oldSlider = f.rowsOf()[0].children[1];
  f.controller.clear();
  input(oldSlider, '0.5');
  assert.equal(f.container.children.length, 0);
  assert.deepEqual(f.order, []);
  f.controller.render(f.options);
  assert.equal(f.rowsOf().length, 2);
});

test('destroy is final and cannot clear a subsequent owner’s DOM', (t) => {
  const f = parameters(t);
  const oldSlider = f.rowsOf()[0].children[1];
  f.controller.destroy();
  const nextOwner = f.container.appendChild(document.createElement('p'));
  f.controller.render(f.options);
  f.controller.clear();
  f.controller.destroy();
  input(oldSlider, '0.5');
  assert.equal(f.container.children.length, 1);
  assert.equal(f.container.firstElementChild === nextOwner, true);
  assert.deepEqual(f.order, []);
});

test('a value snaps to its step from the minimum and stays in bounds', () => {
  const row = { min: 0, max: 1, step: '0.01' };
  assert.equal(snapToStep(0.256, row), 0.26);
  assert.equal(snapToStep(1.4, row), 1);
  assert.equal(snapToStep(-2, row), 0);
  assert.equal(snapToStep(2.04, { min: 0.5, max: 4, step: '0.1' }), 2);
  // Halfway between two steps rounds up, as the browser snaps it.
  assert.equal(snapToStep(1.15, { min: 1, max: 2, step: '0.1' }), 1.2);
  assert.equal(snapToStep(0.125, { min: 0, max: 1, step: '0.01' }), 0.13);
  // A maximum off the grid snaps down to the last step within it.
  assert.equal(snapToStep(1.06, { min: 0, max: 1.06, step: '0.1' }), 1);
  assert.equal(snapToStep(9, { min: 0, max: 1.06, step: '0.1' }), 1);
});

test('rows carry each uniform, its step and its snapped value text', () => {
  const rows = styleParameterRows(
    {
      amount: { label: 'Amount', min: 0, max: 1 },
      scale: { label: 'Scale', min: 0.5, max: 4 },
    },
    (name) => ({ amount: 0.256, scale: 2.04 })[name],
  );
  assert.deepEqual(
    rows.map(({ name, step, digits, value, text }) => [
      name,
      step,
      digits,
      value,
      text,
    ]),
    [
      ['amount', '0.01', 2, 0.256, '0.26'],
      ['scale', '0.1', 1, 2.04, '2.0'],
    ],
  );
  const next = withParameterValue(rows, 'scale', 3.33);
  assert.equal(next[1].value, 3.33);
  assert.equal(next[1].text, '3.3');
  assert.equal(next[0], rows[0], 'the other rows are kept');
});
