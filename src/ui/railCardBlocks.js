import { syncChipGroup } from './chipGroup.js';
import { syncRowList } from './rowList.js';

const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};
const attribute = (node, key, value) => {
  if (node.getAttribute(key) !== value) node.setAttribute(key, value);
};
const order = (parent, nodes) =>
  nodes.forEach((node, i) => {
    if (parent.children[i] !== node)
      parent.insertBefore(node, parent.children[i] || null);
  });

/** Optional, ordered blocks without disclosure state. All controls are keyed. */
export function createRailCardBlocks({ container, cardId, onParams }) {
  const document = container.ownerDocument;
  const blocks = new Map();
  const make = (tag, className, parent) => {
    const node = document.createElement(tag);
    node.className = className;
    parent.appendChild(node);
    return node;
  };
  const dispatch = (props) => {
    if (!props || props.disabled) return;
    if (props.params) onParams(cardId, props.params);
    else props.onClick?.();
  };
  const dispose = (block) => {
    block.removeClick?.();
    block.children?.destroy();
    block.root.remove();
  };
  return {
    update(descriptors = []) {
      const ids = new Set();
      for (const props of descriptors) {
        ids.add(props.id);
        let block = blocks.get(props.id);
        if (block && block.type !== props.type) {
          dispose(block);
          blocks.delete(props.id);
          block = null;
        }
        if (!block) {
          const root = make(
            props.type === 'list'
              ? 'ol'
              : props.type === 'actions'
                ? 'footer'
                : 'div',
            props.type === 'list' ? 'data-row-list' : `rail-card-${props.type}`,
            container,
          );
          root.dataset.blockId = props.id;
          block = { root, type: props.type, props };
          const bind = (fn) => {
            root.addEventListener('click', fn);
            block.removeClick = () => root.removeEventListener('click', fn);
          };
          if (props.type === 'settings') {
            block.children = createRailCardBlocks({
              container: root,
              cardId,
              onParams,
            });
          } else if (props.type === 'setting') {
            block.label = make(
              'span',
              'rail-card-setting-label panel-title',
              root,
            );
            block.chips = make('div', 'rail-card-chips', root);
            block.chips.setAttribute('role', 'group');
            bind((event) => {
              const button = event.target?.closest?.('[data-chip-id]');
              dispatch(
                block.props.chips?.find(
                  ({ id }) => id === button?.dataset.chipId,
                ),
              );
            });
          } else if (props.type === 'list') {
            bind((event) => {
              const button = event.target?.closest?.('.data-row-list-item');
              dispatch(
                block.props.list?.items?.find(
                  ({ id }) => id === button?.dataset.listItemId,
                ),
              );
            });
          } else if (props.type === 'result') {
            block.header = make('div', 'rail-card-result-header', root);
            block.label = make('span', 'panel-title', block.header);
            block.clear = make('button', 'data-toggle-chip', block.header);
            block.clear.type = 'button';
            block.clear.dataset.actionId = 'clear';
            block.clear.textContent = '×';
            block.clear.setAttribute('aria-label', 'Clear reading');
            block.clear.title = 'Clear reading';
            bind((event) => {
              if (event.target === block.clear) dispatch(block.props.clear);
            });
            block.children = createRailCardBlocks({
              container: make('div', 'rail-card-result-lines', root),
              cardId,
              onParams,
            });
          } else if (props.type === 'legend') {
            block.ramp = make('div', 'rail-card-ramp', root);
            block.zero = make('span', 'rail-card-zero', block.ramp);
            block.zero.setAttribute('aria-hidden', 'true');
            block.scale = make('div', 'rail-card-scale', root);
            block.entries = make('div', 'rail-card-legend-entries', root);
          } else if (props.type === 'actions') {
            block.actions = new Map();
            bind((event) => {
              for (const action of block.actions.values())
                if (event.target === action.node) dispatch(action.props);
            });
          } else block.lines = new Map();
          blocks.set(props.id, block);
        }
        block.props = props;
        if (props.type === 'settings')
          block.children.update(
            (props.settings || []).map((setting) => ({
              ...setting,
              type: 'setting',
            })),
          );
        else if (props.type === 'setting') {
          set(block.label, 'textContent', props.label);
          attribute(block.chips, 'aria-label', props.label);
          syncChipGroup(block.chips, props.chips);
        } else if (props.type === 'list') syncRowList(block.root, props.list);
        else if (props.type === 'result') {
          set(block.label, 'textContent', props.label);
          set(block.clear, 'hidden', !props.clear);
          block.children.update([
            { id: 'result-lines', type: 'lines', lines: props.lines },
          ]);
        } else if (props.type === 'legend') {
          const legend = props.legend;
          const colors = (legend?.colors || []).filter((color) =>
            /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color),
          );
          const visible =
            colors.length >= 2 && colors.length === legend.colors.length;
          set(block.root, 'hidden', !visible);
          set(block.ramp, 'hidden', !visible || Boolean(legend?.categorical));
          set(block.scale, 'hidden', Boolean(legend?.categorical));
          set(block.entries, 'hidden', !legend?.categorical);
          if (legend?.categorical) {
            while (block.entries.children.length > colors.length)
              block.entries.children[
                block.entries.children.length - 1
              ].remove();
            colors.forEach((color, index) => {
              let entry = block.entries.children[index];
              if (!entry) {
                entry = make('div', 'rail-card-legend-entry', block.entries);
                make('span', 'rail-card-legend-swatch', entry);
                make('span', '', entry);
              }
              if (entry.dataset.color !== color) {
                entry.children[0].style.background = color;
                entry.dataset.color = color;
              }
              set(entry.children[1], 'textContent', legend.labels[index] || '');
            });
          }
          const gradient = visible
            ? `linear-gradient(to right, ${colors.join(',')})`
            : '';
          if (block.gradient !== gradient) {
            block.ramp.style.background = gradient;
            block.gradient = gradient;
          }
          const zeroVisible =
            visible &&
            legend.units === '°C' &&
            Number.isInteger(legend.zeroIndex) &&
            legend.zeroIndex >= 0 &&
            legend.zeroIndex < colors.length;
          set(block.zero, 'hidden', !zeroVisible);
          if (zeroVisible) {
            const left = `${(legend.zeroIndex / (colors.length - 1)) * 100}%`;
            if (block.zeroLeft !== left) {
              block.zero.style.left = left;
              block.zeroLeft = left;
            }
          }
          set(
            block.scale,
            'textContent',
            visible
              ? `${legend.labels[0]} — ${legend.labels.at(-1)} ${legend.units || ''}`.trim()
              : '',
          );
        } else if (props.type === 'actions') {
          const actions = props.actions || [];
          for (const [id, action] of block.actions)
            if (
              !actions.some(
                (props) =>
                  props.id === id &&
                  (props.href ? 'a' : 'button') === action.tag,
              )
            ) {
              action.node.remove();
              action.hint.remove();
              block.actions.delete(id);
            }
          for (const actionProps of actions) {
            let action = block.actions.get(actionProps.id);
            if (!action) {
              const tag = actionProps.href ? 'a' : 'button';
              const node = make(tag, 'data-toggle-chip', block.root);
              node.dataset.actionId = actionProps.id;
              if (tag === 'button') node.type = 'button';
              else {
                node.target = '_blank';
                node.rel = 'noopener';
              }
              action = {
                node,
                tag,
                hint: make('span', 'rail-card-action-hint', block.root),
              };
              block.actions.set(actionProps.id, action);
            }
            action.props = actionProps;
            set(action.node, 'textContent', actionProps.label);
            set(action.node, 'title', actionProps.title || '');
            set(action.node, 'disabled', Boolean(actionProps.disabled));
            if (action.tag === 'a' && action.href !== actionProps.href) {
              action.node.href = actionProps.href;
              action.href = actionProps.href;
            }
            set(action.hint, 'textContent', actionProps.hint || '');
            set(action.hint, 'hidden', !actionProps.hint);
          }
          order(
            block.root,
            actions.flatMap(({ id }) => {
              const action = block.actions.get(id);
              return [action.node, action.hint];
            }),
          );
        } else {
          const lines = props.lines || [{ id: props.id, text: props.text }];
          for (const [id, node] of block.lines)
            if (!lines.some((line) => line.id === id)) {
              node.remove();
              block.lines.delete(id);
            }
          for (const line of lines) {
            let node = block.lines.get(line.id);
            if (!node) {
              node = make('div', 'rail-card-line', block.root);
              node.dataset.lineId = line.id;
              block.lines.set(line.id, node);
            }
            set(node, 'textContent', String(line.text ?? ''));
            set(
              node,
              'className',
              `rail-card-line${line.muted ? ' muted' : ''}`,
            );
          }
          order(
            block.root,
            lines.map(({ id }) => block.lines.get(id)),
          );
        }
      }
      for (const [id, block] of blocks)
        if (!ids.has(id)) {
          dispose(block);
          blocks.delete(id);
        }
      order(
        container,
        descriptors.map(({ id }) => blocks.get(id).root),
      );
    },
    destroy() {
      for (const block of blocks.values()) dispose(block);
      blocks.clear();
    },
  };
}
