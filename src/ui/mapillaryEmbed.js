/** Public Mapillary embed only. Never accepts credentials or arbitrary frame URLs. */
export function mapillaryPublicImageId(value) {
  const text = String(value || '').trim();
  if (/^\d{5,32}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      !['www.mapillary.com', 'mapillary.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      !['/app', '/app/', '/embed', '/embed/'].includes(url.pathname) ||
      [...url.searchParams.keys()].some((k) =>
        /token|auth|secret|credential|session/i.test(k),
      )
    )
      return null;
    const id =
      url.searchParams.get('pKey') || url.searchParams.get('image_key');
    return /^\d{5,32}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}
export function mapillaryPublicEmbedUrl(id) {
  return /^\d{5,32}$/.test(String(id))
    ? `https://www.mapillary.com/embed?image_key=${id}&style=photo`
    : null;
}
export class MapillaryPublicEmbed {
  constructor({ root, listen }) {
    if (!root) return;
    this.root = root;
    this.input = root.querySelector('input');
    this.status = root.querySelector('[role="status"]');
    this.stage = root.querySelector('.sl-public-stage');
    this.link = root.querySelector('a');
    listen(root.querySelector('[data-sl-public-open]'), 'click', () =>
      this.open(),
    );
    listen(root.querySelector('[data-sl-public-close]'), 'click', () =>
      this.close(),
    );
    listen(this.input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.open();
      }
    });
  }
  open() {
    const id = mapillaryPublicImageId(this.input.value);
    if (!id) {
      this.status.textContent =
        'Paste a public Mapillary photo link or numeric image ID. Credentials and other sites are not accepted.';
      return;
    }
    this.close(false);
    const frame = this.root.ownerDocument.createElement('iframe');
    frame.title = 'Mapillary official street image viewer';
    frame.referrerPolicy = 'no-referrer';
    frame.allow = 'fullscreen';
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-popups',
    );
    frame.src = mapillaryPublicEmbedUrl(id);
    this.stage.append(frame);
    this.stage.hidden = false;
    this.link.href = `https://www.mapillary.com/app/?pKey=${id}&focus=photo`;
    this.link.hidden = false;
    this.status.textContent =
      'Official Mapillary viewer. Image credits remain inside the viewer. If it cannot load, use Open on Mapillary. Mapillary API coverage and this public viewer are separate.';
    this.root.querySelector('[data-sl-public-close]').hidden = false;
  }
  close(feedback = true) {
    if (!this.stage) return;
    this.stage.replaceChildren();
    this.stage.hidden = true;
    this.link.hidden = true;
    this.root.querySelector('[data-sl-public-close]').hidden = true;
    if (feedback) this.status.textContent = 'Public photo viewer closed.';
  }
  destroy() {
    this.close(false);
  }
}
