/** Retain the first limit items in comparator order. Earlier ties stay first. */
export function insertRanked(top, item, limit, compare) {
  if (limit <= 0) return;
  if (top.length === limit && compare(top.at(-1), item) <= 0) return;
  let index = top.length;
  while (index > 0 && compare(item, top[index - 1]) < 0) index--;
  top.splice(index, 0, item);
  if (top.length > limit) top.pop();
}
