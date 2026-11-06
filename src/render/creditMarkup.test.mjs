import assert from 'node:assert/strict';
import test from 'node:test';
import { creditFromMarkup } from './creditMarkup.js';

test('text, the first link and the first logo are read from markup', () => {
  assert.deepEqual(
    creditFromMarkup(
      'Map data <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap</a> (<a href="https://opendatacommons.org/">ODbL</a>)',
    ),
    {
      text: 'Map data © OpenStreetMap (ODbL)',
      href: 'https://www.openstreetmap.org/copyright',
    },
  );
  assert.deepEqual(
    creditFromMarkup(
      '<a href=\'https://cesium.com/\'><img src="/ion.png" title="Cesium ion"/></a>',
    ),
    { text: 'Cesium ion', href: 'https://cesium.com/', logoUrl: '/ion.png' },
  );
  assert.deepEqual(creditFromMarkup('<img src=x.png alt="Logo">'), {
    text: 'Logo',
    logoUrl: 'x.png',
  });
});

test('character references decode; tags, comments and scripts drop', () => {
  assert.deepEqual(
    creditFromMarkup(
      '  A&nbsp;&amp;&#39;B&#x2014;&unknown; <!-- c --><script>x</script>\n  <b>C</b>',
    ),
    { text: "A &'B—&unknown; C" },
  );
  assert.deepEqual(creditFromMarkup('<a data-href="no" href="yes">x</a>'), {
    text: 'x',
    href: 'yes',
  });
  assert.deepEqual(
    creditFromMarkup(
      '<a title="A > B" href="https://example.com/?q=>">Provider</a>',
    ),
    { text: 'Provider', href: 'https://example.com/?q=>' },
  );
  assert.deepEqual(
    creditFromMarkup(
      '<a href="javascript:alert(1)"><img src="javascript:x" alt="L"></a>',
    ),
    { text: 'L' },
  );
  assert.deepEqual(creditFromMarkup('<img src="data:text/html,x" alt="L">'), {
    text: 'L',
  });
  assert.deepEqual(creditFromMarkup(''), { text: '' });
  assert.deepEqual(creditFromMarkup(undefined), { text: '' });
});
