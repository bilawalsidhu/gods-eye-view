import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a card action inside a list card’s detail keeps its own button style', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(
    new URL('./entity-card.css', import.meta.url),
    'utf8',
  );
  document.head.append(style);
  document.body.replaceChildren();
  const section = document.createElement('section');
  section.className = 'nearby-lists context-list-card';
  const detail = document.createElement('div');
  detail.className = 'context-list-card__detail';
  const action = document.createElement('button');
  action.className = 'entity-card__action';
  const row = document.createElement('button');
  detail.append(action);
  const layer = document.createElement('div');
  layer.className = 'nearby-lists__layer';
  const item = document.createElement('li');
  item.append(row);
  const list = document.createElement('ul');
  list.append(item);
  layer.append(list);
  section.append(detail, layer);
  document.body.append(section);

  const actionStyle = getComputedStyle(action);
  assert.equal(actionStyle.display, 'inline-flex');
  assert.notEqual(actionStyle.borderTopStyle, 'none');
  // List rows keep the row style.
  const rowStyle = getComputedStyle(row);
  assert.equal(rowStyle.display, 'flex');
  assert.equal(rowStyle.width, '100%');
});
