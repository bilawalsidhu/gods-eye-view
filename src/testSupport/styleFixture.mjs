import { readFileSync } from 'node:fs';

// Happy DOM needs a single line for selectors and calc() values split across lines.
export function styleFixture(t, sheets, html) {
  const style = document.createElement('style');
  style.textContent = sheets
    .map((name) =>
      readFileSync(
        new URL(`../ui/styles/${name}.css`, import.meta.url),
        'utf8',
      ).replace(/\s*\n\s*/g, ' '),
    )
    .join('\n');
  const host = document.createElement('div');
  host.innerHTML = html;
  document.head.append(style);
  document.body.append(host);
  t.after(() => {
    host.remove();
    style.remove();
  });
  return (selector) => getComputedStyle(host.querySelector(selector));
}
