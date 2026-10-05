/** The offline text library must not load the globe SDK injected into other pages. */
export function discoveryShellPlugin() {
  return {
    name: 'standalone-discovery-shell',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (
          !['/discovery.html', '/planet.html'].includes(context.path) &&
          !['/discovery.html', '/planet.html'].some((path) =>
            context.filename?.replaceAll('\\', '/').endsWith(path),
          )
        )
          return html;
        return html
          .replace(
            /\s*<script\b[^>]*src=["']\/cesium\/Cesium\.js["'][^>]*>\s*<\/script>/g,
            '',
          )
          .replace(
            /\s*<link\b[^>]*href=["']\/cesium\/Widgets\/widgets\.css["'][^>]*>/g,
            '',
          );
      },
    },
  };
}
